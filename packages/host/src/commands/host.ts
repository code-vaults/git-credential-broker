/**
 * `host` — the host broker for typed person actions: create, review, reply, edit issues and pull
 * requests, and fork with the gh account each request names.
 *
 * This runs on the host, beside the checkout the container also sees, and it does exactly one thing:
 * it turns a request file into a pull request, issue, review, reply, issue edit/comment, pull
 * request edit or fork, using the gh account the request names. That is the whole point — content authored by a person is what automated reviewers will
 * actually review, and the app cannot be that person.
 *
 * It has no other power. It cannot push, merge, close or read anything, and it never runs a shell: the
 * program it calls is configuration, and it is called with an argument list built here.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  channelDir,
  clearOpener,
  discoverCheckouts,
  findGitDir,
  listRequests,
  readOpener,
  claimRequest,
  removeRequest,
  requestProblems,
  writeOpener,
  writeResult,
  HOST,
  REPOSITORY,
  type HostRequest,
  type HostOpenResult,
  type BrokerConfig,
} from 'gcb-core';
import { fail, listFlag, parseArgs, say, warn } from 'gcb-core';
import { applyProxyChoice, parseProxy, type ProxyChoice } from '../http.ts';
import { loadConfig, resolveConfigPath } from '../config.ts';
import { hostConfig, repoAllowed } from '../policy.ts';

const run = promisify(execFile);

/** How long one create, review, reply, edit or fork program may take. */
const CREATE_TIMEOUT_MS = 120_000;

/** Usage text for `host`. */
export const HOST_BROKER_USAGE = `Usage: gcb host [options]

Run on the host, once, beside the trees the container also sees. It finds the checkouts under the
roots it is given — ones created later included — and fulfils their typed requests to create a pull
request, issue or fork, reply to a review comment, submit a review, or edit an issue or pull
request, with the gh account each request names. The result is authored by a person rather than by the app's bot. It cannot push, merge or close anything.

  --root <dir>          A tree to serve, repeatable (default: $HOME)
  --depth <n>           How far below a root to look for checkouts (default: 4)
  --repo <path>         Serve this one checkout instead of discovering any
  --config <path>       Broker config whose allowlist fork, reply and explicit-repository requests use
                        (default: $GIT_BROKER_CONFIG, else ./broker.config.yml)
  --command <path>      The program that creates, replies or forks
                        (default: $GIT_BROKER_PR_COMMAND, else gh)
  --arg <token>         An extra argument for that program, before the subcommand (repeatable)
  --interval <seconds>  How often to look for requests (default: 5)
  --once                Fulfil what is waiting, then exit
  -h, --help            Show this help

The container asks for this by passing --as-user to \`pr\`. Requests are files under
<git dir>/gcb/pr-requests, which is shared with the container and untracked by git
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
 * Pull the issue number and URL out of the program's output.
 *
 * @param output - the program's standard output.
 * @returns the number and URL, or `undefined`.
 */
export function issueUrl(output: string): { number: number; url: string } | undefined {
  const match = /https:\/\/[^\s]+\/issues\/(\d+)/.exec(output);
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
  const args = parseArgs(argv, { booleans: ['help', 'once'] });
  if (args.has('help') || args.has('h')) {
    say(HOST_BROKER_USAGE);
    return 0;
  }

  const explicit = args.value('repo');
  const single = explicit === undefined ? undefined : resolve(explicit);
  const roots = listFlag(args, 'root');
  const scanned = roots.length > 0 ? roots.map((root) => resolve(root)) : [homedir()];
  const depth = Number(args.value('depth') ?? '4');
  const command = args.value('command') ?? process.env['GIT_BROKER_PR_COMMAND'] ?? 'gh';
  const configPath = args.value('config');
  let config: BrokerConfig | undefined;
  /** Whether the broker config allowlist permits this host/repository for a fork, reply or explicit repository. */
  const allowed = (host: string, repo: string): boolean => {
    if (config === undefined) {
      try {
        config = loadConfig(resolveConfigPath(configPath));
      } catch (error) {
        throw new Error(
          `a fork, reply or explicit repository needs the broker config allowlist: ${(error as Error).message}; pass --config or set GIT_BROKER_CONFIG`,
        );
      }
    }
    const block = hostConfig(config, host);
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

  const advertised = new Set<string>();
  /** Advertise a channel, without rewriting the marker on every sweep. */
  const advertise = (dir: string): void => {
    advertised.add(dir);
    if (readOpener(dir)?.pid !== process.pid) {
      writeOpener(dir, {
        pid: process.pid,
        command,
        startedAt: new Date().toISOString(),
        kinds: ['pull-request', 'issue', 'issue-edit', 'issue-comment', 'review', 'reply', 'edit', 'fork'],
      });
    }
  };
  // However this process ends — a signal, --once, an exception — its markers go with it. A stale
  // marker would tell the container a host broker is there and make it wait for an answer that is not
  // coming.
  process.on('exit', () => {
    for (const dir of advertised) {
      try {
        if (readOpener(dir)?.pid === process.pid) clearOpener(dir);
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
        await sweep(dir, repo, command, extra, allowed);
      } catch (error) {
        warn(`could not serve ${repo}: ${(error as Error).message}`);
      }
    }
    if (args.has('once')) return 0;
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
): Promise<number> {
  let answered = 0;
  for (const id of listRequests(dir)) {
    // Claimed, not read: two host brokers — a service and a hand-run --once — would otherwise both act on the
    // same request and each create it, under the person's name.
    const request = claimRequest(dir, id);
    if (!request) {
      // Either unreadable or already claimed, and the two are not worth telling apart here: removing
        // anything now would delete another host broker's claim, which is the claim's whole purpose.
        warn(`skipped ${id}: unreadable, or another host broker has it`);
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
    const result = await openOne(repo, command, extra, { ...request, proxy }, allowed);
    writeResult(dir, id, result);
    removeRequest(dir, id);
    if (result.error !== undefined) {
      warn(
        `failed to open ${
          request.kind === 'fork'
            ? 'fork'
            : request.kind === 'issue'
              ? 'issue'
              : request.kind === 'reply'
                ? `reply on #${request.number}`
                : request.kind === 'review'
                  ? `review on #${request.number}`
                  : request.kind === 'edit'
                    ? `edit on #${request.number}`
                    : request.kind === 'issue-edit' || request.kind === 'issue-comment'
                      ? `issue #${request.number}`
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
                : request.kind === 'issue-edit'
                  ? `edited issue #${result.number} as ${request.account ?? 'this user'}${result.url === undefined ? '' : `: ${result.url}`}`
                  : request.kind === 'issue-comment'
                    ? `commented on issue #${result.number} as ${request.account ?? 'this user'}${result.url === undefined ? '' : `: ${result.url}`}`
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

/**
 * Run one person operation: check the allowlist, then call the program and turn its failure into a result.
 *
 * The five typed routes (review, reply, pull request edit, issue edit and issue comment) differ only in the
 * argv they build, so the check and the catch live here once instead of being copied per route.
 */
async function personRun(
  host: string,
  repository: string,
  allowed: (host: string, repo: string) => boolean,
  work: (host: string) => Promise<HostOpenResult>,
): Promise<HostOpenResult> {
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
  work: (bodyFile: string) => Promise<HostOpenResult>,
): Promise<HostOpenResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'gcb-body-'));
  try {
    const bodyFile = join(scratch, 'body.md');
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
): Promise<HostOpenResult> {
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

  if (request.kind === 'issue-edit' || request.kind === 'issue-comment') {
    const host = request.host ?? 'github.com';
    const edit = request.kind === 'issue-edit';
    return personRun(host, request.repo, allowed, async (host) => {
      const invoke = (bodyFile?: string) =>
        run(
          command,
          [
            ...extra,
            'issue',
            edit ? 'edit' : 'comment',
            String(request.number),
            '--repo',
            request.repo,
            ...(edit && request.title !== undefined ? [`--title=${request.title}`] : []),
            ...(bodyFile === undefined ? [] : ['--body-file', bodyFile]),
          ],
          {
            cwd: repo,
            timeout: CREATE_TIMEOUT_MS,
            maxBuffer: 1 << 20,
            env: forkEnv(request.proxy, request.account, host),
          },
        ).then(({ stdout }) => issueUrl(stdout) ?? { number: request.number });
      return request.body === undefined ? invoke() : withBodyFile(request.body, invoke);
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
  const issue = request.kind === 'issue';
  let scratch: string | undefined;
  try {
    scratch = mkdtempSync(join(tmpdir(), 'gcb-'));
    const bodyFile = join(scratch, 'body.md');
    writeFileSync(bodyFile, request.body, 'utf8');
    const { stdout, stderr } = await run(
      command,
      [
        ...extra,
        issue ? 'issue' : 'pr',
        'create',
        // Without an explicit repository gh resolves the checkout it runs in; with one the allowlist
        // above is the boundary, and no checkout of the target is required.
        ...(!issue && request.draft === true ? ['--draft'] : []),
        ...(target === undefined ? [] : ['--repo', target]),
        ...(issue ? [] : ['--base', request.base, '--head', request.head]),
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
    const found = issue ? issueUrl(stdout) : pullRequestUrl(stdout);
    if (!found) {
      return {
        error: `no ${issue ? 'issue' : 'pull request'} URL in the output: ${(stdout.trim() || stderr.trim()).slice(0, 300)}`,
      };
    }
    return found;
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    const reason = (failure.stderr ?? failure.message ?? 'the command failed').trim();
    return { error: reason.slice(0, 300) || 'the command failed' };
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}
