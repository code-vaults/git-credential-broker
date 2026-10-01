/**
 * `host-opener` — fulfil the container's requests to open pull requests, as the person running it.
 *
 * This runs on the host, beside the checkout the container also sees, and it does exactly one thing:
 * it turns a request file into a pull request, using the credentials of whoever started it. That is
 * the whole point — a pull request authored by a person is one that automated reviewers will actually
 * review, and the app cannot be that person.
 *
 * It has no other power. It cannot push, merge, close or read anything, and it never runs a shell: the
 * program it calls is configuration, and it is called with an argument list built here.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  type HostOpenRequest,
  type HostOpenResult,
} from '../host-request.ts';
import { fail, listFlag, parseArgs, say, warn } from './support.ts';

const run = promisify(execFile);

/** How long one `pr create` may take. */
const CREATE_TIMEOUT_MS = 120_000;

/** Usage text for `host-opener`. */
export const HOST_OPENER_USAGE = `Usage: git-credential-broker host-opener [options]

Run on the host, once, beside the trees the container also sees. It finds the checkouts under the
roots it is given — ones created later included — and fulfils their requests to open a pull request
with the credentials of whoever runs it, so the pull request is authored by a person rather than by
the app's bot. It does nothing else: it cannot push, merge or close anything.

  --root <dir>          A tree to serve, repeatable (default: $HOME)
  --depth <n>           How far below a root to look for checkouts (default: 4)
  --repo <path>         Serve this one checkout instead of discovering any
  --command <path>      The program that creates a pull request
                        (default: $GIT_BROKER_PR_COMMAND, else gh)
  --arg <token>         An extra argument for that program, before the subcommand (repeatable)
  --interval <seconds>  How often to look for requests (default: 5)
  --once                Fulfil what is waiting, then exit
  -h, --help            Show this help

The container asks for this by passing --via-host to \`pr\`. Requests are files under
<git dir>/git-credential-broker/pr-requests, which is shared with the container and untracked by git
— so the paths on the two sides never have to match: each writes and reads its own view of the same
directory, and only the roots this process scans are host-side paths.
`;

/**
 * Read a pull request's number and URL out of a program's output.
 *
 * `gh pr create` prints the URL, and so does anything that behaves like it. Nothing else is trusted:
 * without a URL in the output the opener reports a failure rather than guessing.
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
 * Run the `host-opener` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code.
 */
export async function runHostOpener(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help', 'once'] });
  if (args.has('help') || args.has('h')) {
    say(HOST_OPENER_USAGE);
    return 0;
  }

  const explicit = args.value('repo');
  const single = explicit === undefined ? undefined : resolve(explicit);
  const roots = listFlag(args, 'root');
  const scanned = roots.length > 0 ? roots.map((root) => resolve(root)) : [homedir()];
  const depth = Number(args.value('depth') ?? '4');
  const command = args.value('command') ?? process.env['GIT_BROKER_PR_COMMAND'] ?? 'gh';
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
      writeOpener(dir, { pid: process.pid, command, startedAt: new Date().toISOString() });
    }
  };
  // However this process ends — a signal, --once, an exception — its markers go with it. A stale
  // marker would tell the container an opener is there and make it wait for an answer that is not
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
  say(`creating pull requests with ${command}${extra.length > 0 ? ` ${extra.join(' ')}` : ''}, as ${process.env['USER'] ?? 'this user'}`);

  for (;;) {
    for (const { repo, dir } of targets()) {
      advertise(dir);
      await sweep(dir, repo, command, extra);
    }
    if (args.has('once')) return 0;
    await new Promise((done) => setTimeout(done, Math.max(interval, 0) * 1000));
  }
}

/**
 * Answer everything waiting in the channel.
 *
 * @param dir - the channel directory.
 * @param repo - the checkout to create pull requests in.
 * @param command - the program to call.
 * @param extra - arguments to pass before the subcommand.
 * @returns how many requests were answered.
 */
async function sweep(dir: string, repo: string, command: string, extra: readonly string[]): Promise<number> {
  let answered = 0;
  for (const id of listRequests(dir)) {
    // Claimed, not read: two openers — a service and a hand-run --once — would otherwise both act on the
    // same request and each create the pull request, under the person's name.
    const request = claimRequest(dir, id);
    if (!request) {
      // Either unreadable or already claimed, and the two are not worth telling apart here: removing
        // anything now would delete another opener's claim, which is the claim's whole purpose.
        warn(`skipped ${id}: unreadable, or another opener has it`);
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

    const result = await openOne(repo, command, extra, request);
    writeResult(dir, id, result);
    removeRequest(dir, id);
    if (result.error !== undefined) {
      warn(`failed to open ${request.head}: ${result.error}`);
    } else {
      say(`opened #${result.number}: ${result.url}`);
    }
    answered += 1;
  }
  return answered;
}

/**
 * Create one pull request.
 *
 * @param repo - the checkout to create it in.
 * @param command - the program to call.
 * @param extra - arguments to pass before the subcommand.
 * @param request - what to create.
 * @returns the number and URL, or the reason it did not work.
 */
async function openOne(
  repo: string,
  command: string,
  extra: readonly string[],
  request: HostOpenRequest,
): Promise<HostOpenResult> {
  // The body goes to a private temp file: the program is given a path, never a string to interpret.
  const scratch = mkdtempSync(join(tmpdir(), 'git-credential-broker-'));
  const bodyFile = join(scratch, 'body.md');
  writeFileSync(bodyFile, request.body, 'utf8');
  try {
    const { stdout, stderr } = await run(
      command,
      [
        ...extra,
        'pr',
        'create',
        // No `--repo`: gh resolves the repository from the checkout it runs in, which is the checkout the
        // request was written in. That is a mechanism, not a boundary — the container can edit that checkout,
        // its remote included. What a deployment controls is which roots are served and which program runs;
        // what this reaches is whatever the person running it can reach.
        // against, so a request cannot aim the opener at another one.
        ...(request.draft === true ? ['--draft'] : []),
        '--base',
        request.base,
        '--head',
        request.head,
        '--title',
        request.title,
        '--body-file',
        bodyFile,
      ],
      { cwd: repo, timeout: CREATE_TIMEOUT_MS, maxBuffer: 1 << 20 },
    );
    const found = pullRequestUrl(stdout);
    if (!found) {
      return { error: `no pull request URL in the output: ${(stdout.trim() || stderr.trim()).slice(0, 300)}` };
    }
    return found;
  } catch (error) {
    const failure = error as { stderr?: string; message?: string };
    const reason = (failure.stderr ?? failure.message ?? 'the command failed').trim();
    return { error: reason.slice(0, 300) || 'the command failed' };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
