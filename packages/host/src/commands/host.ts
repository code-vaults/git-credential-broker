/**
 * `host` — the host broker for typed person actions: create, review, reply, edit, run catalogued
 * actions, and fork with the gh account each request names.
 *
 * This runs on the host, beside the checkout the container also sees, and it does exactly one thing:
 * it turns a request file into a pull request, review, reply, pull request edit, catalogued action
 * or fork, using the gh account the request names. That is the whole point — content authored by a person is what automated reviewers will
 * actually review, and the app cannot be that person.
 *
 * It has no other power than the catalogued actions: it cannot push or merge, and it never runs a
 * shell; the program it calls is configuration, and it is called with an argument list built here.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  channelDir,
  clearHostBroker,
  discoverCheckouts,
  findGitDir,
  listRequests,
  reclaimAbandoned,
  readHostBroker,
  claimRequest,
  removeRequest,
  requestProblems,
  writeHostBroker,
  writeJsonAtomic,
  readJson,
  writeResult,
  PACKAGE_VERSION,
  canonicalPath,
  apiBodyJson,
  HOST,
  REPOSITORY,
  ANSWER_TIMEOUT_MS,
  type HostRequest,
  type HostResult,
  buildGhArgv,
  getGhAction,
  type BrokerConfig,
} from 'gcb-core';
import { fail, listFlag, parseArgs, say, warn } from 'gcb-core';
import { applyProxyChoice, fetcherFor, parseProxy, type ProxyChoice } from '../http.ts';
import { loadConfig, resolveConfigPath } from '../config.ts';
import { hostConfig, parseAllowEntry, repoAllowed } from '../policy.ts';
import { isForkOfRepository, isPublicRepository } from '../public-repo.ts';

const run = promisify(execFile);

/** How long one create, review, reply, edit or fork program may take. */
const CREATE_TIMEOUT_MS = 120_000;

/** Host-private daemon status, independent of any config path. */
export function hostStatusPath(): string {
  return join(homedir(), '.gcb-host', 'status.json');
}

/** The daemon state `host status` reports. */
interface HostStatus {
  readonly pid: number;
  readonly config: string | null;
  readonly cwd: string;
  readonly version: string;
  readonly startedAt: string;
}

/** Per-stream byte budget for a host action, small enough that JSON escaping stays under readResult's cap. */
const HOST_ACTION_OUTPUT_BYTES = 48_000;

/** What one bounded action process produced. */
export interface BoundedResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Run an action with streaming output caps.
 *
 * execFile's maxBuffer kills the child once a fixed buffer fills; a large diff or log would then be
 * reported as a gh failure even though only the excess output is unusable. Read both streams to the
 * end, keep the first bytes of each, and tell the caller where the cut is.
 */
export function runBounded(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; writeCaveat?: boolean },
): Promise<BoundedResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ stdout: '', stderr: (error as Error).message, code: 1 });
      return;
    }

    const suffix = '\n[output truncated]\n';
    const timeoutNote =
      options.writeCaveat === false
        ? 'the action timed out\n'
        : 'the action timed out; a write may have completed before it was killed\n';
    const outKeep = HOST_ACTION_OUTPUT_BYTES - Buffer.byteLength(suffix);
    const errKeep = outKeep - Buffer.byteLength(timeoutNote);
    const stdout = new StringDecoder('utf8');
    const stderr = new StringDecoder('utf8');
    let out = '';
    let err = '';
    let outBytes = 0;
    let errBytes = 0;
    let outCut = false;
    let errCut = false;
    let timedOut = false;
    let settled = false;

    const append = (decoder: StringDecoder, chunk: Buffer, stream: 'out' | 'err'): void => {
      const limit = stream === 'out' ? outKeep : errKeep;
      const used = stream === 'out' ? outBytes : errBytes;
      if (used >= limit) {
        if (stream === 'out') outCut = true;
        else errCut = true;
        return;
      }
      const piece = chunk.subarray(0, limit - used);
      const text = decoder.write(piece);
      if (stream === 'out') {
        out += text;
        outBytes += piece.length;
        if (piece.length < chunk.length) outCut = true;
      } else {
        err += text;
        errBytes += piece.length;
        if (piece.length < chunk.length) errCut = true;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => append(stdout, chunk, 'out'));
    child.stderr?.on('data', (chunk: Buffer) => append(stderr, chunk, 'err'));
    child.on('error', (error) => finish({ stdout: out, stderr: err || error.message, code: 1 }));

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    }, options.timeoutMs);

    function finish(result: BoundedResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      out += stdout.end();
      err += stderr.end();
      if (outCut) out += suffix;
      if (errCut) err += suffix;
      if (err === '' && result.stderr !== '') err = result.stderr;
      if (timedOut) {
        if (err !== '' && !err.endsWith('\n')) err += '\n';
        err += timeoutNote;
      }
      resolve({ ...result, stdout: out, stderr: err });
    }

    child.on('close', (code, signal) => {
      finish({ stdout: out, stderr: err, code: timedOut || signal !== null ? 1 : (code ?? 1) });
    });
  });
}

/** Usage text for `host`. */
export const HOST_BROKER_USAGE = `Usage: gcb host [options]

Run on the host, once, beside the trees the container also sees. It finds the checkouts under the
roots it is given — ones created later included — and fulfils their typed requests to create a pull
request, reply to a review comment, submit a review, edit a pull request, run a catalogued action or
fork, with the gh account each request names. The result is authored by a person rather than by the app's bot.

  --root <dir>          A tree to serve, repeatable (default: $HOME)
  --depth <n>           How far below a root to look for checkouts (default: 4)
  --repo <path>         Serve this one checkout instead of discovering any
  --config <path>       Broker config whose allowlist fork, reply and explicit-repository requests use
                        (default: $GIT_BROKER_CONFIG, else ./broker.config.yml)
  --command <path>      The program that creates, replies or forks
                        (default: $GCB_HOST_COMMAND, else gh)
  --arg <token>         An extra argument for that program, before the subcommand (repeatable)
  --interval <seconds>  How often to look for requests (default: 5)
  --once                Fulfil what is waiting, then exit
  status                Report the running host daemon as JSON
  -h, --help            Show this help

The container asks for this by passing --as-user to \`pr\`. Requests are files under
<git dir>/gcb/host-broker, which is shared with the container and untracked by git
— so the paths on the two sides never have to match: each writes and reads its own view of the same
directory, and only the roots this process scans are host-side paths.
`;

/**
 * Read a pull request's number and URL out of a program's output.
 *
 * `gh pr create` prints the URL, and so does anything that behaves like it. Nothing else is trusted:
 * without a URL in the output the host broker reports a failure rather than guessing.
 *
 * @param output - the program's standard output.
 * @returns the number and URL, or `undefined`.
 */
export function pullRequestUrl(output: string): { number: number; url: string } | undefined {
  const match = /https:\/\/[^\s]+\/pull\/(\d+)/.exec(output);
  const digits = match?.[1];
  if (!match || digits === undefined) return undefined;
  return { number: Number(digits), url: match[0] };
}

/**
 * Run the `host` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code.
 */
export async function runHostBroker(argv: readonly string[]): Promise<number> {
  const statusMode = argv[0] === 'status';
  const args = parseArgs(statusMode ? argv.slice(1) : argv, { booleans: ['help', 'once'] });
  const once = args.has('once');
  if (args.has('help') || args.has('h')) {
    say(HOST_BROKER_USAGE);
    return 0;
  }

  const explicit = args.value('repo');
  const single = explicit === undefined ? undefined : resolve(explicit);
  const roots = listFlag(args, 'root');
  const scanned = roots.length > 0 ? roots.map((root) => resolve(root)) : [homedir()];
  const depth = Number(args.value('depth') ?? '4');
  const command = args.value('command') ?? process.env['GCB_HOST_COMMAND'] ?? 'gh';
  const configPath = args.value('config');
  const resolvedConfig = resolveConfigPath(configPath);
  const statusFile = hostStatusPath();
  const startedAt = new Date().toISOString();
  let loadedConfig: string | null = null;
  /** Remove the status file only when this process owns it. */
  function removeOwnStatus(): void {
    try {
      const current = readJson(statusFile);
      if (
        typeof current === 'object' &&
        current !== null &&
        !Array.isArray(current) &&
        (current as { pid?: unknown }).pid === process.pid
      ) {
        rmSync(statusFile, { force: true });
      }
    } catch {
      // Nothing to clean up.
    }
  }
  /** Rewrite the host-private status file; the channel marker is not trusted for this. */
  function writeStatus(): void {
    if (once) return;
    let collision: boolean;
    try {
      collision = canonicalPath(resolvedConfig) === canonicalPath(statusFile);
    } catch (error) {
      warn(`could not compare the config and status paths: ${(error as Error).message}`);
      return;
    }
    if (collision) fail('the config cannot be the host status file');
    try {
      writeJsonAtomic(statusFile, {
        pid: process.pid,
        config: loadedConfig,
        cwd: process.cwd(),
        version: PACKAGE_VERSION,
        startedAt,
      });
    } catch (error) {
      warn(`could not write host status: ${(error as Error).message}`);
    }
  }
  let config: BrokerConfig | undefined;
  /** Resolve one host block, loading the configuration on first use. */
  const blockFor = (host: string) => {
    if (config === undefined) {
      try {
        config = loadConfig(resolveConfigPath(configPath));
        loadedConfig = resolvedConfig;
        writeStatus();
      } catch (error) {
        throw new Error(
          `a fork, reply or explicit repository needs the broker config allowlist: ${(error as Error).message}; pass --config or set GIT_BROKER_CONFIG`,
        );
      }
    }
    return hostConfig(config, host);
  };
  /** Whether the broker config allowlist permits this host/repository for a fork, reply or explicit repository. */
  const allowed = (host: string, repo: string): boolean => {
    const block = blockFor(host);
    return block !== null && repoAllowed(block.allow, repo);
  };
  const extra = listFlag(args, 'arg');
  const interval = Number(args.value('interval') ?? '5');
  if (!Number.isFinite(interval) || interval < 1) {
    fail(`--interval must be at least one second, got ${JSON.stringify(args.value('interval'))}`);
  }
  if (!Number.isInteger(depth) || depth < 0) {
    fail(`--depth must be a whole number of levels, got ${JSON.stringify(args.value('depth'))}`);
  }

  /** The checkouts to serve: one named checkout, or everything under the roots. */
  const targets = (): { repo: string; dir: string }[] => {
    if (single === undefined) return scanned.flatMap((root) => discoverCheckouts(root, depth));
    const gitDir = findGitDir(single);
    if (gitDir === undefined) fail(`no git repository at or above ${single}`);
    return [{ repo: single, dir: channelDir(gitDir) }];
  };

  if (statusMode) {
    if (
      args.value('config') !== undefined ||
      args.value('command') !== undefined ||
      args.value('repo') !== undefined ||
      listFlag(args, 'root').length > 0
    ) {
      fail('status takes no --config/--command/--repo/--root');
    }
    const parsed = readJson(statusFile);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail('no host broker is running');
    }
    const status = parsed as Partial<HostStatus>;
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    const pid = status.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
      fail('no host broker is running');
    }
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') fail('no host broker is running');
    }
    const output = {
      pid,
      config: text(status.config),
      cwd: text(status.cwd),
      version: text(status.version),
      startedAt: text(status.startedAt),
    };
    say(JSON.stringify([output]));
    return 0;
  }
  writeStatus();

  const advertised = new Set<string>();
  /** Advertise a channel, without rewriting the marker on every sweep. */
  const advertise = (dir: string): void => {
    advertised.add(dir);
    if (readHostBroker(dir)?.pid !== process.pid) {
      writeHostBroker(dir, {
        pid: process.pid,
        command,
        startedAt: new Date().toISOString(),
        kinds: ['pull-request', 'review', 'reply', 'edit', 'action', 'fork'],
      });
    }
  };
  // However this process ends — a signal, --once, an exception — its markers go with it. A stale
  // marker would tell the container a host broker is there and make it wait for an answer that is not
  // coming.
  process.on('exit', () => {
    removeOwnStatus();
    for (const dir of advertised) {
      try {
        if (readHostBroker(dir)?.pid === process.pid) clearHostBroker(dir);
      } catch {
        // Nothing useful is left to do while exiting.
      }
    }
  });
  const stop = () => process.exit(0);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  say(single === undefined ? `serving the checkouts under ${scanned.join(', ')}` : `serving ${single}`);
  say(
    `creating pull requests, issues, reviews, replies and forks with ${command}${extra.length > 0 ? ` ${extra.join(' ')}` : ''}, as the request's account or this user`,
  );

  for (;;) {
    for (const { repo, dir } of targets()) {
      // One checkout the container has made hostile — its channel directory replaced by a file, say —
      // must not stop the host broker serving every other root, under Restart=always least of all.
      try {
        advertise(dir);
        await sweep(dir, repo, command, extra, allowed, blockFor);
      } catch (error) {
        warn(`could not serve ${repo}: ${(error as Error).message}`);
      }
    }
    if (once) return 0;
    await new Promise((done) => setTimeout(done, Math.max(interval, 0) * 1000));
  }
}

/**
 * Answer everything waiting in the channel.
 *
 * @param dir - the channel directory.
 * @param repo - the checkout to create pull requests or issues in.
 * @param command - the program to call.
 * @param extra - arguments to pass before the subcommand.
 * @returns how many requests were answered.
 */
async function sweep(
  dir: string,
  repo: string,
  command: string,
  extra: readonly string[],
  allowed: (host: string, repo: string) => boolean,
  blockFor: (host: string) => ReturnType<typeof hostConfig>,
): Promise<number> {
  let answered = 0;
  const reclaimed = reclaimAbandoned(dir);
  for (const id of reclaimed.unknown) {
    warn(`reclaimed ${id}: outcome unknown; the request was left by a host that exited`);
  }
  for (const id of reclaimed.answered) {
    warn(`recovered ${id}: an answer was already present`);
  }
  for (const id of listRequests(dir)) {
    // Claimed, not read: two host brokers — a service and a hand-run --once — would otherwise both act on the
    // same request and each create it, under the person's name.
    let requestAge = 0;
    try {
      requestAge = Date.now() - statSync(join(dir, `${id}.json`)).mtimeMs;
    } catch {
      // The claim below reports a vanished request; age is only used after a successful claim.
    }
    const request = claimRequest(dir, id);
    if (!request) {
      // Either unreadable or already claimed, and the two are not worth telling apart here: removing
        // anything now would delete another host broker's claim, which is the claim's whole purpose.
        warn(`skipped ${id}: unreadable, or another host broker has it`);
      continue;
    }
    if (requestAge > ANSWER_TIMEOUT_MS) {
      writeResult(dir, id, { error: `request ${id} expired before the host claimed it` });
      removeRequest(dir, id);
      warn(`refused ${id}: it expired before the host claimed it`);
      continue;
    }

    const problems = requestProblems(request);
    if (problems.length > 0) {
      writeResult(dir, id, { error: problems.join('; ') });
      removeRequest(dir, id);
      warn(`refused ${id}: ${problems.join('; ')}`);
      answered += 1;
      continue;
    }

    const proxy = parseProxy(request.proxy);
    if (proxy === false) {
      writeResult(dir, id, { error: 'invalid proxy in the request' });
      removeRequest(dir, id);
      warn(`refused ${id}: invalid proxy`);
      answered += 1;
      continue;
    }
    const result = await openOne(repo, command, extra, { ...request, proxy }, allowed, blockFor);
    writeResult(dir, id, result);
    removeRequest(dir, id);
    if (result.error !== undefined) {
      warn(
        `failed to open ${
          request.kind === 'fork'
            ? 'fork'
            : request.kind === 'reply'
                ? `reply on #${request.number}`
                : request.kind === 'review'
                  ? `review on #${request.number}`
                  : request.kind === 'edit'
                    ? `edit on #${request.number}`
                    : request.kind === 'action'
                        ? request.action
                        : request.head
        }: ${result.error}`,
      );
    } else {
      say(
        request.kind === 'fork'
          ? `forked ${request.repo} as ${request.account ?? 'this user'}: ${result.url}`
          : request.kind === 'reply'
            ? `replied on #${result.number} as ${request.account ?? 'this user'}: ${result.url}`
            : request.kind === 'review'
              ? `reviewed #${result.number} (${request.event}) as ${request.account ?? 'this user'}${result.url === undefined ? '' : `: ${result.url}`}`
              : request.kind === 'edit'
                ? `edited #${result.number} as ${request.account ?? 'this user'}${result.url === undefined ? '' : `: ${result.url}`}`
                    : request.kind === 'action'
                      ? `ran ${request.action} as ${request.account ?? 'this user'}`
                      : `opened #${result.number} as ${request.account ?? 'this user'}: ${result.url}`,
      );
    }
    answered += 1;
  }
  return answered;
}

/** Environment for one gh call: the selected account or inherited config, plus the proxy choice. */
function forkEnv(proxy: ProxyChoice, account: string | undefined, host: string): NodeJS.ProcessEnv {
  const env = hostEnv(proxy, account);
  // gh chooses between GH_TOKEN and GH_ENTERPRISE_TOKEN by host; forcing GH_HOST is what keeps an
  // inherited token from selecting another instance. Named accounts already had their tokens removed.
  env['GH_HOST'] = host;
  return env;
}

function hostEnv(proxy: ProxyChoice, account?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (account !== undefined) {
    const dir = join(homedir(), '.config', `gh-${account}`);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      throw new Error(`no gh config for account ${JSON.stringify(account)} at ${dir}`);
    }
    // Tokens in the host broker's own environment would override the selected account's config.
    delete env['GH_TOKEN'];
    delete env['GITHUB_TOKEN'];
    delete env['GH_ENTERPRISE_TOKEN'];
    delete env['GITHUB_ENTERPRISE_TOKEN'];
    delete env['GH_HOST'];
    env['GH_CONFIG_DIR'] = dir;
  }
  applyProxyChoice(env, proxy);
  return env;
}

/** Unauthenticated public-repository check for the host route. */
async function repoIsPublic(
  host: string,
  repository: string,
  proxy: ProxyChoice,
  apiBaseUrl?: string,
  apiVersion = '2022-11-28',
): Promise<boolean> {
  const base =
    apiBaseUrl ?? (host.toLowerCase() === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`);
  return isPublicRepository(fetcherFor(proxy), base, repository, apiVersion);
}

/**
 * Whether an allowlisted fork's parent is the requested repository.
 *
 * @param host - the forge host.
 * @param allow - the configured allowlist entries.
 * @param repository - the requested parent repository.
 * @param proxy - the proxy choice for the check.
 * @param apiBaseUrl - an optional API base.
 * @param apiVersion - the API version header.
 * @returns true when one allowlisted fork names the repository as its parent.
 */
async function forkAllows(
  host: string,
  allow: readonly string[],
  repository: string,
  proxy: ProxyChoice,
  apiBaseUrl?: string,
  apiVersion = '2022-11-28',
): Promise<boolean> {
  const base =
    apiBaseUrl ?? (host.toLowerCase() === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`);
  for (const raw of allow) {
    const entry = parseAllowEntry(raw);
    if (!entry || entry.owner === '*' || entry.repo === '*') continue;
    const fork = `${entry.owner}/${entry.repo}`;
    if (fork === repository.toLowerCase()) continue;
    try {
      if (await isForkOfRepository(fetcherFor(proxy), base, fork, repository, apiVersion)) return true;
    } catch {
      // A failed check is not evidence of a relationship; keep looking, then fail closed.
    }
  }
  return false;
}

/**
 * Run one person operation: check the allowlist, then call the program and turn its failure into a result.
 *
 * The typed routes differ only in the argv they build, so the check and the catch live here once
 * instead of being copied per route.
 */
async function personRun(
  host: string,
  repository: string,
  allowed: (host: string, repo: string) => boolean,
  work: (host: string) => Promise<HostResult>,
): Promise<HostResult> {
  if (!HOST.test(host)) return { error: `not a host: ${JSON.stringify(host)}` };
  try {
    if (!allowed(host, repository)) {
      return { error: `repository ${repository} is not in the allowlist for ${host}` };
    }
  } catch (error) {
    return { error: (error as Error).message };
  }
  try {
    return await work(host);
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    const reason = (failure.stderr ?? failure.message ?? 'the command failed').trim();
    return { error: reason.slice(0, 300) || 'the command failed' };
  }
}

/** Run work with a body in a private temp file, and remove it afterwards. */
async function withBodyFile(
  body: string,
  work: (bodyFile: string) => Promise<HostResult>,
  name = 'body.md',
): Promise<HostResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'gcb-body-'));
  try {
    const bodyFile = join(scratch, name);
    writeFileSync(bodyFile, body, 'utf8');
    return await work(bodyFile);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Create one pull request, issue, review, reply, edit or comment.
 *
 * @param repo - the checkout to run it in.
 * @param command - the program to call.
 * @param extra - arguments to pass before the subcommand.
 * @param request - what to do.
 * @returns the number and URL, or the reason it did not work.
 */
async function openOne(
  repo: string,
  command: string,
  extra: readonly string[],
  request: HostRequest,
  allowed: (host: string, repo: string) => boolean,
  blockFor: (host: string) => ReturnType<typeof hostConfig>,
): Promise<HostResult> {
  if (request.kind === 'fork') {
    if (request.host !== undefined && !HOST.test(request.host)) {
      return { error: `not a host: ${JSON.stringify(request.host)}` };
    }
    const host = request.host ?? 'github.com';
    try {
      if (!allowed(host, request.repo)) {
        return { error: `repository ${request.repo} is not in the allowlist for ${host}` };
      }
    } catch (error) {
      return { error: (error as Error).message };
    }
    try {
      const { stdout, stderr } = await run(command, [...extra, 'repo', 'fork', request.repo], {
        cwd: repo,
        timeout: CREATE_TIMEOUT_MS,
        maxBuffer: 1 << 20,
        env: forkEnv(request.proxy, request.account, host),
      });
      const match = /https:\/\/[^\s]+\/[^\s/]+\/[^\s/]+/.exec(stdout);
      if (match?.[0] !== undefined) return { url: match[0] };
      // With no TTY, gh prints the URL only for a fresh fork; an existing fork older than a minute
      // is `owner/name already exists` on stderr with empty stdout and exit 0.
      const existing = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+) already exists$/m.exec(stderr);
      if (existing?.[1] !== undefined) {
        return { url: `https://${host}/${existing[1]}` };
      }
      return { error: `no fork URL in the output: ${(stdout.trim() || stderr.trim()).slice(0, 300)}` };
    } catch (error) {
      const failure = error as { stderr?: string; message?: string };
      const reason = (failure.stderr ?? failure.message ?? 'the command failed').trim();
      return { error: reason.slice(0, 300) || 'the command failed' };
    }
  }

  if (request.kind === 'action') {
    const host = request.host ?? 'github.com';
    let action: ReturnType<typeof getGhAction>;
    try {
      action = getGhAction(request.action);
    } catch (error) {
      return { error: (error as Error).message };
    }

    if (request.values['jq'] !== undefined) {
      return {
        error:
          '--jq is unavailable through the host broker; drop it and filter the JSON locally ' +
          '(--json selects fields where supported)',
      };
    }

    const runAction = async (env: NodeJS.ProcessEnv): Promise<HostResult> => {
      const deadline = Date.now() + action.timeoutSeconds * 1_000;
      if (action.target === 'issue') {
        try {
          buildGhArgv(request.action, request.values, request.repo);
        } catch (error) {
          return { error: (error as Error).message };
        }
        const number = Number(request.values['number']);
        if (!Number.isSafeInteger(number) || number <= 0) {
          return { error: `${String(number)} is not an issue number` };
        }
        const probe = await runBounded(
          command,
          [...extra, 'api', `repos/${request.repo}/issues/${String(number)}`, '--jq', '.pull_request != null'],
          {
            cwd: repo,
            env,
            timeoutMs: Math.max(1, deadline - Date.now()),
          },
        );
        if (probe.code !== 0) {
          return { error: probe.stderr.trim() || 'could not verify the issue target' };
        }
        if (probe.stdout.trim() === 'true') {
          return { error: `#${String(number)} is a pull request, not an issue` };
        }
      }
      const body = typeof request.values['body'] === 'string' ? request.values['body'] : undefined;
      const invoke = async (bodyFile?: string): Promise<HostResult> => {
        const argv = buildGhArgv(request.action, request.values, request.repo, bodyFile);
        const result = await runBounded(command, [...extra, ...argv], {
          cwd: repo,
          env,
          timeoutMs: Math.max(1, deadline - Date.now()),
          writeCaveat: Object.values(action.permissions).some((permission) => permission === 'write'),
        });
        return result;
      };
      if (body === undefined) return invoke();
      if (action.api?.jsonBody === true) {
        return withBodyFile(apiBodyJson(body), invoke, 'body.json');
      }
      return withBodyFile(body, invoke);
    };

    let hostBlock: ReturnType<typeof blockFor>;
    try {
      hostBlock = blockFor(host);
    } catch (error) {
      return { error: (error as Error).message };
    }
    if (hostBlock === null) {
      return { error: `no configuration for ${host}` };
    }
    let allowedByFork = false;
    if (!repoAllowed(hostBlock.allow, request.repo) && hostBlock.allowFork === true) {
      const apiBaseUrl = 'apiBaseUrl' in hostBlock ? hostBlock.apiBaseUrl : undefined;
      const apiVersion = 'apiVersion' in hostBlock ? hostBlock.apiVersion : undefined;
      allowedByFork = await forkAllows(host, hostBlock.allow, request.repo, request.proxy, apiBaseUrl, apiVersion);
    }
    if (!repoAllowed(hostBlock.allow, request.repo) && !allowedByFork) {
      const allowedPublic = action.readOnly === true && hostBlock.allowPublicRead === true;
      if (!allowedPublic) {
        return { error: `repository ${request.repo} is not in the allowlist for ${host}` };
      }
      try {
        const apiBaseUrl = 'apiBaseUrl' in hostBlock ? hostBlock.apiBaseUrl : undefined;
        const apiVersion = 'apiVersion' in hostBlock ? hostBlock.apiVersion : undefined;
        if (!(await repoIsPublic(host, request.repo, request.proxy, apiBaseUrl, apiVersion))) {
          return { error: `repository ${request.repo} is not public` };
        }
      } catch (error) {
        return { error: (error as Error).message };
      }
      try {
        return await runAction(forkEnv(request.proxy, request.account, host));
      } catch (error) {
        return { error: (error as Error).message };
      }
    }

    return personRun(host, request.repo, allowedByFork ? () => true : allowed, async (host) =>
      runAction(forkEnv(request.proxy, request.account, host)),
    );
  }

  if (request.kind === 'reply') {
    const host = request.host ?? 'github.com';
    return personRun(host, request.repo, allowed, async (host) => {
      const { stdout, stderr } = await run(
        command,
        [
          ...extra,
          'api',
          '--method',
          'POST',
          `/repos/${request.repo}/pulls/${request.number}/comments/${request.commentId}/replies`,
          '--raw-field',
          `body=${request.body}`,
        ],
        {
          cwd: repo,
          timeout: CREATE_TIMEOUT_MS,
          maxBuffer: 1 << 20,
          env: forkEnv(request.proxy, request.account, host),
        },
      );
      let answer: unknown = null;
      try {
        answer = JSON.parse(stdout);
      } catch {
        answer = null;
      }
      const reply = (answer ?? {}) as { html_url?: unknown };
      if (typeof reply.html_url !== 'string' || reply.html_url === '') {
        return { error: `no reply URL in the output: ${(stdout.trim() || stderr.trim()).slice(0, 300)}` };
      }
      return { number: request.number, url: reply.html_url };
    });
  }

  if (request.kind === 'edit') {
    const host = request.host ?? 'github.com';
    return personRun(host, request.repo, allowed, async (host) => {
      const invoke = (bodyFile?: string) =>
        run(
          command,
          [
            ...extra,
            'pr',
            'edit',
            String(request.number),
            '--repo',
            request.repo,
            ...(request.title === undefined ? [] : [`--title=${request.title}`]),
            ...(bodyFile === undefined ? [] : ['--body-file', bodyFile]),
            ...(request.base === undefined ? [] : [`--base=${request.base}`]),
          ],
          {
            cwd: repo,
            timeout: CREATE_TIMEOUT_MS,
            maxBuffer: 1 << 20,
            env: forkEnv(request.proxy, request.account, host),
          },
        ).then(({ stdout }) => pullRequestUrl(stdout) ?? { number: request.number });
      return request.body === undefined ? invoke() : withBodyFile(request.body, invoke);
    });
  }

  if (request.kind === 'review') {
    const host = request.host ?? 'github.com';
    const flag =
      request.event === 'approve'
        ? '--approve'
        : request.event === 'request-changes'
          ? '--request-changes'
          : '--comment';
    return personRun(host, request.repo, allowed, async (host) => {
      const invoke = (bodyFile?: string) =>
        run(
          command,
          [
            ...extra,
            'pr',
            'review',
            String(request.number),
            '--repo',
            request.repo,
            flag,
            ...(bodyFile === undefined ? [] : ['--body-file', bodyFile]),
          ],
          {
            cwd: repo,
            timeout: CREATE_TIMEOUT_MS,
            maxBuffer: 1 << 20,
            env: forkEnv(request.proxy, request.account, host),
          },
        ).then(({ stdout }) => {
          const match = /https:\/\/[^\s]+\/pull\/\d+(?:#pullrequestreview-\d+)?/.exec(stdout);
          return match?.[0] === undefined ? { number: request.number } : { number: request.number, url: match[0] };
        });
      return request.body.trim() === '' ? invoke() : withBodyFile(request.body, invoke);
    });
  }

  // An explicit repository is the allowlist's decision, not the checkout's: the request may name a
  // repository this machine has no checkout of. Without one, gh still resolves the checkout.
  const target = request.repo;
  if (target !== undefined) {
    if (!REPOSITORY.test(target)) return { error: `not a repository: ${JSON.stringify(target)}` };
    try {
      if (!allowed('github.com', target)) {
        return { error: `repository ${target} is not in the allowlist for github.com` };
      }
    } catch (error) {
      return { error: (error as Error).message };
    }
  }
  // The body goes to a private temp file: the program is given a path, never a string to interpret.
  try {
    return await withBodyFile(request.body, async (bodyFile) => {
      const { stdout, stderr } = await run(
        command,
        [
          ...extra,
          'pr',
          'create',
          // Without an explicit repository gh resolves the checkout it runs in; with one the allowlist
          // above is the boundary, and no checkout of the target is required.
          ...(request.draft === true ? ['--draft'] : []),
          ...(target === undefined ? [] : ['--repo', target]),
          '--base', request.base, '--head', request.head,
          `--title=${request.title}`,
          '--body-file',
          bodyFile,
        ],
        {
          cwd: repo,
          timeout: CREATE_TIMEOUT_MS,
          maxBuffer: 1 << 20,
          env:
            target === undefined
              ? hostEnv(request.proxy, request.account)
              : forkEnv(request.proxy, request.account, 'github.com'),
        },
      );
      const found = pullRequestUrl(stdout);
      if (!found) {
        return { error: `no pull request URL in the output: ${(stdout.trim() || stderr.trim()).slice(0, 300)}` };
      }
      return found;
    });
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    const reason = (failure.stderr ?? failure.message ?? 'the command failed').trim();
    return { error: reason.slice(0, 300) || 'the command failed' };
  }
}
