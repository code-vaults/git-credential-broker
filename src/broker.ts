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
import net from 'node:net';
import path from 'node:path';

import { tokenFingerprint } from './audit.ts';
import { hostConfig, normalizeRepoPath, repoAllowed } from './policy.ts';
import { createLineReader, encodeMessage, parseMessage } from './socket-protocol.ts';
import type { AuditSink, BrokerConfig, Provider, WireResponse } from './types.ts';

/** Reported by the `ping` operation so the container side can prove what it reached. */
export const BROKER_VERSION = '0.1.0';

/** How long one socket connection may stay idle before it is dropped. */
const REQUEST_TIMEOUT_MS = 30_000;

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
 * symlink, a regular file, a directory — is refused rather than overwritten, because the
 * path may sit in a directory the agent container can write to.
 *
 * @param socketPath - the configured socket path.
 * @throws {Error} when the path exists and is not a stale socket.
 */
export function prepareSocketPath(socketPath: string): void {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
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
    throw new Error(`refusing to replace a non-socket at ${socketPath}`);
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
    if (message['op'] !== 'credential') {
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
    if (protocol !== 'https' && !(protocol === 'http' && insecureHttpAllowed)) {
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
      // The caller gets a generic message: provider errors can embed API responses.
      const reason = String((error as Error).message ?? error).slice(0, 300);
      return deny(
        context,
        CODES.PROVIDER_ERROR,
        reason,
        'the broker could not mint a credential; see the broker log',
      );
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
