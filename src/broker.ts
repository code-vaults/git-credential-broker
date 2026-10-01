/**
 * The broker itself: a unix-socket server that turns a (host, repository) request into one
 * short-lived credential.
 *
 * Why a unix socket and not the LAN HTTP API the original design proposed: the container
 * runs with `http_proxy`/`https_proxy`/`all_proxy` pointing at another machine and with
 * `NODE_USE_ENV_PROXY=1`, so a plain-HTTP broker hop would route the shared key and the
 * minted token through that proxy, in cleartext. A socket on the filesystem is reachable
 * only from this host, ignores proxy environment variables entirely, and needs no TLS,
 * nonce or replay window.
 *
 * Security properties enforced here:
 *  - default deny: unknown host, missing path, unparsable path and unlisted repository are
 *    all refusals, each recorded in the audit log;
 *  - the credential is scoped to exactly one repository and to narrowed permissions;
 *  - a refusal never explains internals to the caller (details go to the host-side log);
 *  - the socket path is created by this process and refuses to replace anything that is not
 *    already a socket, and refuses to follow a symlink.
 */
import fs from 'node:fs';
import { ProviderConfigError } from './errors.ts';
import net from 'node:net';
import path from 'node:path';

import { tokenFingerprint } from './audit.ts';
import { socketPathRefusal } from './platform.ts';
import { hostConfig, normalizeRepoPath, repoAllowed } from './policy.ts';
import { createLineReader, encodeMessage, parseMessage } from './socket-protocol.ts';
import type { MergeMethod, AuditSink, BrokerConfig, Provider, WireResponse } from './types.ts';
import { BRANCH } from './host-request.ts';

/** Reported by the `ping` operation so the container side can prove what it reached. */
export const BROKER_VERSION = '0.1.0';

/** How long one socket connection may stay idle before it is dropped. */
// How long a connection may stay silent before it is dropped. It has to outlast the longest wait a client
// makes on it: `pr` waits PR_TIMEOUT_MS (60s) for an answer that arrives only when the handler finishes, and
// the handler is silent on the socket the whole time. At 30s the timer won every long action, and the client
// reported "unreachable" for a merge or a close that had already happened.
const REQUEST_TIMEOUT_MS = 120_000;

/** Response codes returned to the helper. */
export const CODES = {
  BAD_REQUEST: 'bad-request',
  PROTOCOL_NOT_HTTPS: 'protocol-not-https',
  HOST_NOT_ALLOWED: 'host-not-allowed',
  PATH_REQUIRED: 'path-required',
  REPO_NOT_ALLOWED: 'repo-not-allowed',
  PROVIDER_ERROR: 'provider-error',
} as const;

/** Audit context shared by allow and deny records. */
interface DecisionContext {
  host: string | null;
  repo: string | null;
  session: string | null;
  helper_pid: number | null;
}

/** Options for {@link createRequestHandler}. */
export interface RequestHandlerOptions {
  readonly config: BrokerConfig;
  readonly audit: AuditSink;
  readonly providers: ReadonlyMap<string, Provider>;
  /** Host-side diagnostics sink; never seen by the caller. */
  readonly log?: (message: string) => void;
}

/**
 * Make the socket path safe to bind.
 *
 * A stale socket left by a crashed broker is removed. Anything else at that path — a
 * symlink, a regular file, a directory — is refused rather than overwritten, because the path
 * may sit in a directory the agent container can write to. The containing directory is checked
 * for the same reason: a symlinked directory would let the container choose where the socket
 * gets bound.
 *
 * @param socketPath - the configured socket path.
 * @throws {Error} when the path exists and is not a stale socket, or the directory is a symlink.
 */
export function prepareSocketPath(socketPath: string): void {
  // Before creating anything: a Windows-backed mount inside WSL is 9p/drvfs, which will not carry a
  // unix socket. Failing here names the reason; failing at bind time does not.
  const refusal = socketPathRefusal(socketPath);
  if (refusal !== null) {
    throw new Error(`refusing to bind at ${socketPath}: ${refusal}`);
  }
  const directory = path.dirname(socketPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Explicitly, not only in the mkdir call: on an ACL-based share (Synology's `synoacl`, which is
  // where this was measured) the mode given to a create call is advisory and the directory comes
  // out world-accessible. These permissions are the only thing stopping another local user from
  // connecting to the socket and asking the broker for credentials.
  fs.chmodSync(directory, 0o700);
  if (fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error(`refusing to bind inside a symlinked directory: ${directory}`);
  }
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`refusing to use socket path that is a symlink: ${socketPath}`);
  }
  if (!stats.isSocket()) {
    throw new Error(
      `refusing to replace ${socketPath}: something that is not a socket is in the way. ` +
        'If it is a leftover — an interrupted start, or a stray redirect onto the path — remove it and start again.',
    );
  }
  fs.unlinkSync(socketPath);
}

/**
 * Build the request handler. Kept separate from the server so it can be unit-tested without
 * a socket.
 *
 * @param options - handler options.
 * @returns the handler.
 */
export function createRequestHandler(
  options: RequestHandlerOptions,
): (message: Record<string, unknown>) => Promise<WireResponse> {
  const { config, audit, providers, log = () => {} } = options;

  /**
   * Record a refusal and produce the caller-visible response.
   *
   * @param context - host/repo/session context.
   * @param code - the response code.
   * @param reason - the detailed reason; host-side log and audit only for provider errors.
   * @param message - what the caller is told.
   * @returns the refusal.
   */
  function deny(context: DecisionContext, code: string, reason: string, message: string): WireResponse {
    audit.record({ event: 'credential', decision: 'deny', ...context, code, reason });
    log(
      `deny ${code} host=${context.host ?? '-'} repo=${context.repo ?? '-'} reason=${reason}`,
    );
    return { ok: false, code, reason: message };
  }

  return async function handle(message: Record<string, unknown>): Promise<WireResponse> {
    const context: DecisionContext = {
      host: typeof message['host'] === 'string' ? message['host'] : null,
      repo: null,
      session: typeof message['session'] === 'string' ? message['session'].slice(0, 128) : null,
      helper_pid:
        typeof message['pid'] === 'number' && Number.isInteger(message['pid']) ? message['pid'] : null,
    };

    if (message['op'] === 'ping') {
      return { ok: true, version: BROKER_VERSION, hosts: [...providers.keys()] };
    }
    if (
      message['op'] !== 'credential' &&
      message['op'] !== 'logs' &&
      message['op'] !== 'pull-request'
    ) {
      return deny(
        context,
        CODES.BAD_REQUEST,
        `unknown op ${JSON.stringify(message['op'])}`,
        'unsupported operation',
      );
    }

    // Host first: whether plaintext is tolerated is a property of the *host's* configuration,
    // not of the request, so the protocol can only be judged once the host is known.
    const block = hostConfig(config, message['host']);
    if (!block) {
      return deny(context, CODES.HOST_NOT_ALLOWED, 'no configuration for this host', 'host is not configured');
    }
    context.host = block.host;

    const protocol = message['protocol'];
    const insecureHttpAllowed = block.allowInsecureHttp === true;
    if (
      message['op'] === 'credential' &&
      protocol !== 'https' &&
      !(protocol === 'http' && insecureHttpAllowed)
    ) {
      return deny(
        context,
        CODES.PROTOCOL_NOT_HTTPS,
        `protocol=${JSON.stringify(protocol)} (allowInsecureHttp=${String(insecureHttpAllowed)})`,
        'only https is served for this host (a plaintext request would expose the credential on the wire)',
      );
    }

    const repo = normalizeRepoPath(message['path']);
    if (!repo) {
      const reason =
        typeof message['path'] === 'string' && message['path']
          ? `unparsable path ${JSON.stringify(message['path'])}`
          : 'no path sent: git omits it unless credential.useHttpPath is enabled';
      return deny(
        context,
        CODES.PATH_REQUIRED,
        reason,
        'the request carries no usable repository path, so a single-repository credential cannot be issued; enable `git config --global credential.useHttpPath true`',
      );
    }
    context.repo = repo.full;

    if (!repoAllowed(block.allow, repo.full)) {
      return deny(context, CODES.REPO_NOT_ALLOWED, 'repository not in allowlist', 'repository is not allowlisted');
    }

    const provider = providers.get(block.host);
    if (!provider) {
      return deny(context, CODES.PROVIDER_ERROR, 'no provider instance for this host', 'provider unavailable');
    }

    if (message['op'] === 'logs') {
      const jobId = message['jobId'];
      if (typeof jobId !== 'number' || !Number.isInteger(jobId) || jobId <= 0) {
        return deny(
          context,
          CODES.BAD_REQUEST,
          `bad jobId ${JSON.stringify(jobId)}`,
          'the request carries no usable workflow job id',
        );
      }
      if (typeof provider.getJobLog !== 'function') {
        return deny(
          context,
          CODES.PROVIDER_ERROR,
          `provider ${provider.name} cannot read logs`,
          "this host's provider cannot read workflow logs",
        );
      }
      try {
        const jobLog = await provider.getJobLog({
          host: block.host,
          owner: repo.owner,
          repo: repo.repo,
          jobId,
        });
        audit.record({
          event: 'logs',
          decision: 'allow',
          ...context,
          job_id: jobId,
          bytes: Buffer.byteLength(jobLog.text, 'utf8'),
          truncated: jobLog.truncated === true,
        });
        return { ok: true, log: jobLog.text, truncated: jobLog.truncated === true };
      } catch (error) {
        // Same rule as a credential: a provider response can embed anything, so only our own
        // configuration errors are shown to the caller.
        const reason = String((error as Error).message ?? error).slice(0, 300);
        const callerMessage =
          error instanceof ProviderConfigError
            ? reason
            : 'the broker could not read that log; see the broker log';
        return deny(context, CODES.PROVIDER_ERROR, reason, callerMessage);
      }
    }

    if (message['op'] === 'pull-request') {
      const action = message['action'] ?? 'open';
      if (
        action !== 'open' &&
        action !== 'close' &&
        action !== 'merge' &&
        action !== 'update' &&
        action !== 'status' &&
        action !== 'comment' &&
        action !== 'threads' &&
        action !== 'reply' &&
        action !== 'resolve'
      ) {
        return deny(context, CODES.BAD_REQUEST, `bad action ${JSON.stringify(action)}`, 'unknown pull request action');
      }
      const number = message['number'];
      const commentId = message['commentId'];
      const threadId = message['threadId'];
      const head = message['head'];
      const base = message['base'];
      const title = message['title'];
      const body = message['body'];
      const filePath = message['filePath'];
      const line = message['line'];
      const side = message['side'] ?? 'right';
      const method = message['method'] ?? 'squash';
      const branch = BRANCH;
      const usable = (value: unknown): value is string =>
        typeof value === 'string' && branch.test(value) && !value.includes('..');

      if (action === 'open' && !usable(head)) {
        return deny(context, CODES.BAD_REQUEST, `bad head ${JSON.stringify(head)}`, 'the head branch name is not usable');
      }
      if ((action === 'open' || action === 'update') && base !== undefined && !usable(base)) {
        return deny(context, CODES.BAD_REQUEST, `bad base ${JSON.stringify(base)}`, 'the base branch name is not usable');
      }
      if (action === 'open' && (typeof title !== 'string' || title.trim() === '' || title.length > 256)) {
        return deny(context, CODES.BAD_REQUEST, 'bad title', 'a pull request needs a title of at most 256 characters');
      }
      if (body !== undefined && (typeof body !== 'string' || body.length > 65_536)) {
        return deny(context, CODES.BAD_REQUEST, 'bad body', 'the body must be text of at most 65536 characters');
      }

      // An anchored comment: both halves or neither, only on a comment, and never outside the repository.
      const anchored = filePath !== undefined || line !== undefined;
      if (anchored && action !== 'comment') {
        return deny(context, CODES.BAD_REQUEST, `anchor fields with ${action}`, 'only a comment can be anchored to a file and a line');
      }
      if (anchored && (filePath === undefined || line === undefined)) {
        return deny(context, CODES.BAD_REQUEST, 'half an anchor', 'an anchored comment needs a file and a line, or neither');
      }
      if (filePath !== undefined) {
        if (
          typeof filePath !== 'string' ||
          filePath === '' ||
          filePath.startsWith('/') ||
          filePath.length > 1024 ||
          filePath.split('/').includes('..')
        ) {
          return deny(context, CODES.BAD_REQUEST, `bad file path ${JSON.stringify(filePath)}`, 'the file path is not usable');
        }
      }
      if (line !== undefined && (!Number.isInteger(line) || Number(line) <= 0)) {
        return deny(context, CODES.BAD_REQUEST, `bad line ${JSON.stringify(line)}`, 'the line has to be a positive number');
      }
      if (side !== 'left' && side !== 'right') {
        return deny(context, CODES.BAD_REQUEST, `bad side ${JSON.stringify(side)}`, 'the side has to be left or right');
      }
      if (action === 'update' && title === undefined && body === undefined && base === undefined) {
        return deny(context, CODES.BAD_REQUEST, 'empty update', 'an update has to change a title, a body or a base');
      }
      if ((action === 'comment' || action === 'reply') && (typeof body !== 'string' || body.trim() === '')) {
        return deny(context, CODES.BAD_REQUEST, 'empty comment', 'a comment has to say something');
      }
      if (action === 'reply' && (typeof commentId !== 'number' || !Number.isInteger(commentId) || commentId <= 0)) {
        return deny(context, CODES.BAD_REQUEST, 'bad commentId', 'a reply needs the id of the comment it answers');
      }
      if (action === 'resolve' && (typeof threadId !== 'string' || threadId === '')) {
        return deny(context, CODES.BAD_REQUEST, 'bad threadId', 'resolving needs the id of the thread, which --threads prints');
      }
      if (action !== 'open' && action !== 'resolve' && (typeof number !== 'number' || !Number.isInteger(number) || number <= 0)) {
        return deny(context, CODES.BAD_REQUEST, `bad number ${JSON.stringify(number)}`, 'this action needs a pull request number');
      }
      if (action === 'merge' && method !== 'merge' && method !== 'squash' && method !== 'rebase') {
        return deny(context, CODES.BAD_REQUEST, `bad method ${JSON.stringify(method)}`, 'the merge method must be merge, squash or rebase');
      }
      if (typeof provider.pullRequest !== 'function') {
        return deny(
          context,
          CODES.PROVIDER_ERROR,
          `provider ${provider.name} cannot manage pull requests`,
          "this host's provider cannot manage pull requests",
        );
      }
      try {
        const result = await provider.pullRequest({
          host: block.host,
          owner: repo.owner,
          repo: repo.repo,
          action,
          ...(typeof number === 'number' ? { number } : {}),
          ...(typeof commentId === 'number' ? { commentId } : {}),
          ...(typeof threadId === 'string' ? { threadId } : {}),
        ...(typeof filePath === 'string' ? { filePath } : {}),
        ...(typeof line === 'number' ? { line } : {}),
        ...(typeof filePath === 'string' && typeof line === 'number' ? { side } : {}),
          ...(typeof head === 'string' ? { head } : {}),
          ...(typeof base === 'string' ? { base } : {}),
          ...(typeof title === 'string' ? { title } : {}),
          ...(typeof body === 'string' ? { body } : {}),
          ...(action === 'merge' ? { method: method as MergeMethod } : {}),
          draft: message['draft'] === true,
        });
        audit.record({
          event: 'pull-request',
          decision: 'allow',
          ...context,
          action,
          ...(typeof number === 'number' ? { number } : {}),
          ...(typeof head === 'string' ? { head } : {}),
          ...(typeof base === 'string' ? { base } : {}),
          pr_number: result.number,
          pr_url: result.url,
        });
        return {
          ok: true,
          prNumber: result.number,
          prUrl: result.url,
          prState: result.state,
          prMerged: result.merged === true,
          prStatus: result.status,
        };
      } catch (error) {
        const reason = String((error as Error).message ?? error).slice(0, 300);
        const callerMessage =
          error instanceof ProviderConfigError
            ? reason
            : 'the broker could not manage that pull request; see the broker log';
        return deny(context, CODES.PROVIDER_ERROR, reason, callerMessage);
      }
    }

    try {
      const credential = await provider.getCredential({
        host: block.host,
        owner: repo.owner,
        repo: repo.repo,
        full: repo.full,
      });
      audit.record({
        event: 'credential',
        decision: 'allow',
        ...context,
        provider: provider.name,
        token_fingerprint: tokenFingerprint(credential.password),
        expires_at: new Date(credential.expiresAt).toISOString(),
        cached: credential.cached === true,
      });
      return {
        ok: true,
        username: credential.username,
        password: credential.password,
        expires_at: new Date(credential.expiresAt).toISOString(),
      };
    } catch (error) {
      // The caller normally gets a generic message, because provider errors can embed API
      // responses. A ProviderConfigError is ours — a permission name and the configuration — and
      // passing it on is the difference between "see the broker log" and knowing what is missing.
      const reason = String((error as Error).message ?? error).slice(0, 300);
      const message =
        error instanceof ProviderConfigError
          ? reason
          : 'the broker could not mint a credential; see the broker log';
      return deny(context, CODES.PROVIDER_ERROR, reason, message);
    }
  };
}

/** Options for {@link startBroker}. */
export interface StartBrokerOptions {
  readonly config: BrokerConfig;
  readonly audit: AuditSink;
  readonly providers: ReadonlyMap<string, Provider>;
  readonly log?: (message: string) => void;
}

/** A running broker. */
export interface RunningBroker {
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * Start the broker.
 *
 * @param options - server options.
 * @returns the running broker.
 */
export async function startBroker(options: StartBrokerOptions): Promise<RunningBroker> {
  const { config, audit, providers, log = () => {} } = options;
  prepareSocketPath(config.socketPath);
  const handle = createRequestHandler({ config, audit, providers, log });

  const server = net.createServer({ allowHalfOpen: false }, (socket) => {
    socket.setTimeout(REQUEST_TIMEOUT_MS);
    const reader = createLineReader({
      onLine: (line) => {
        const message = parseMessage(line);
        const respond = (response: WireResponse): void => {
          if (!socket.destroyed) socket.write(encodeMessage(response));
        };
        if (!message) {
          respond({ ok: false, code: CODES.BAD_REQUEST, reason: 'malformed request' });
          return;
        }
        handle(message).then(respond, (error: unknown) => {
          respond({ ok: false, code: CODES.PROVIDER_ERROR, reason: 'internal broker error' });
          log(`internal error: ${String((error as Error).message ?? error)}`);
        });
      },
      onOverflow: () => socket.destroy(),
    });
    socket.on('data', reader);
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => {});
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(config.socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });

  if (config.socketMode) fs.chmodSync(config.socketPath, config.socketMode);
  log(`listening on ${config.socketPath} (mode ${config.socketMode.toString(8)})`);

  return {
    socketPath: config.socketPath,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        fs.unlinkSync(config.socketPath);
      } catch {
        // Already gone: fine.
      }
    },
  };
}
