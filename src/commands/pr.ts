/**
 * `pr` — open, close, merge or update one pull request through the broker.
 *
 * The credential never leaves the broker. The broker mints a token narrowed to `pull_requests: write`
 * plus read access to the branches it names, performs the action itself, and answers with the number,
 * the URL and the state: the agent gets the lifecycle of a pull request without ever holding
 * something that could push to it.
 *
 * Exit codes: 0 done, 1 refused, 3 broker unreachable.
 */
import { readFileSync } from 'node:fs';

import {
  ANSWER_TIMEOUT_MS,
  channelDir,
  findGitDir,
  readOpener,
  removeResult,
  waitForResult,
  writeRequest,
} from '../host-request.ts';
import { requestOverSocket, resolveSocketPath } from '../helper.ts';
import { qualifiedBranch } from './remotes.ts';
import { fail, parseArgs, say } from './support.ts';

/** Longer than a credential request: a token is minted, then the action is performed. */
const PR_TIMEOUT_MS = 60_000;

/** Usage text for `pr`. */
export const PR_USAGE = `Usage: git-credential-broker pr [options]

Open, close, merge, update or inspect a pull request through the broker, without the credential
ever reaching this side.

Opening (the default)
  --head <branch>      The branch holding the change                 [required]
  --base <branch>      The branch to merge into (default: main)
  --title <text>       The title                                     [required]
  --body <text>        The body, inline
  --body-file <path>   The body, read from a file — a pull request body is usually long
  --draft              Open it as a draft
  --via-host           Ask a host-side opener to create it, as you, instead of as the app
                       (run 'git-credential-broker host-opener' on the host to provide one)

Acting on one
  --number <n>         The pull request number                       [required]
  --status             Report its state, mergeability and the runs for its commit
  --comment            Post the body as a comment on it (needs only --number and --body/--body-file)
  --threads            List its review threads: their ids, whether they are resolved, and the comments
  --reply-to <id>      Reply inside the thread that comment id belongs to, with --body/--body-file
  --resolve <thread>   Mark that review thread resolved (the id --threads prints)
  --close              Close it
  --merge              Merge it (branch protection still applies)
  --method <m>         merge, squash (default) or rebase
  With --number and none of the above, the title, body or base is updated.

Common
  --socket <path>      Broker socket (default: $GIT_BROKER_SOCKET or the socket file)
  --host <host>        Host as configured, e.g. github.com           [required]
  --repo <owner/name>  Repository the pull request belongs to        [required]
  -h, --help           Show this help
`;


/**
 * Read the action out of the flags.
 *
 * @param args - the parsed arguments.
 * @returns `close`, `merge`, `update` or `open`.
 */
function actionOf(args: { has(name: string): boolean; value(name: string): string | undefined }) {
  if (args.value('resolve') !== undefined) return 'resolve' as const;
  if (args.value('reply-to') !== undefined) return 'reply' as const;
  if (args.has('threads')) return 'threads' as const;
  if (args.has('comment')) return 'comment' as const;
  if (args.has('status')) return 'status' as const;
  if (args.has('close')) return 'close' as const;
  if (args.has('merge')) return 'merge' as const;
  if (args.value('number') !== undefined) return 'update' as const;
  return 'open' as const;
}

/**
 * Run the `pr` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code: 0 done, 1 refused, 3 unreachable.
 */
export async function runPr(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, {
    booleans: ['help', 'draft', 'close', 'merge', 'status', 'comment', 'threads', 'via-host'],
  });
  if (args.has('help') || args.has('h')) {
    say(PR_USAGE);
    return 0;
  }

  const socketPath = resolveSocketPath(args.value('socket'), process.env);
  const host = args.value('host');
  const repo = args.value('repo') ?? fail('--repo is required (e.g. owner/name)');
  const action = actionOf(args);
  const viaHost = action === 'open' && args.has('via-host');
  if (!host && !viaHost) fail('--host is required (e.g. github.com)');
  if (!repo) fail('--repo is required (e.g. owner/name), also with --via-host: the opener passes it on');

  const number = args.value('number');
  // `--head origin:feat/x` and `--base upstream:main` name a configured remote instead of a repository
  // typed by hand: it is the name this checkout already pushes to, and a typo lists the ones that exist.
  // The base is a branch of the repository --repo names, so the owner a remote resolves to is a check
  // rather than part of the value: sending `owner:branch` as a base names a branch that cannot exist.
  const baseBranch = (): string | undefined => {
    const raw = args.value('base');
    if (raw === undefined) return undefined;
    const colon = raw.indexOf(':');
    if (colon < 0) return raw;
    const resolved = qualifiedBranch(raw, process.cwd());
    const owner = resolved.slice(0, resolved.indexOf(':'));
    if (`${owner}/${repo.split('/')[1] ?? ''}`.toLowerCase() !== repo.toLowerCase()) {
      fail(`--base names a remote pointing at ${owner}/…, but --repo is ${repo}: the base is a branch of the repository the pull request lands in`);
    }
    return raw.slice(colon + 1);
  };
  const qualified = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    try {
      return qualifiedBranch(value, process.cwd());
    } catch (error) {
      fail((error as Error).message);
    }
  };
  const head = qualified(args.value('head'));
  const base = baseBranch();
  const title = args.value('title');
  const bodyFile = args.value('body-file');
  let body = args.value('body');
  if (bodyFile !== undefined) {
    try {
      body = readFileSync(bodyFile, 'utf8');
    } catch (error) {
      fail(`cannot read ${bodyFile}: ${(error as Error).message}`);
    }
  }

  if (action === 'open') {
    if (!head) fail('--head is required to open a pull request');
    if (!title) fail('--title is required to open a pull request');
  } else if (action !== 'resolve' && number === undefined) {
    const verb = action === 'status' ? 'inspect' : action;
    fail(`--number is required to ${verb} a pull request`);
  } else if (action !== 'resolve' && (!Number.isInteger(Number(number)) || Number(number) <= 0)) {
    fail(`--number must be a positive integer, got ${JSON.stringify(number)}`);
  }
  if (action === 'update' && title === undefined && body === undefined && base === undefined) {
    fail('an update has to change something: pass --title, --body/--body-file or --base');
  }
  if ((action === 'comment' || action === 'reply') && (body === undefined || body.trim() === '')) {
    fail('a comment has to say something: pass --body or --body-file');
  }
  const replyTo = args.value('reply-to');
  if (action === 'reply' && (replyTo === undefined || !Number.isInteger(Number(replyTo)) || Number(replyTo) <= 0)) {
    fail(`--reply-to needs the id of the comment being answered, got ${JSON.stringify(replyTo)}`);
  }

  if (viaHost) {
    if (head === undefined || title === undefined) fail('--via-host needs --head and --title');
    const gitDir = findGitDir(process.cwd());
    if (gitDir === undefined) fail('--via-host needs a git repository: run it from the checkout');
    const dir = channelDir(gitDir);
    if (readOpener(dir) === undefined) {
      fail(
        `no host opener is watching ${dir}\n` +
          '  start one on the host: git-credential-broker host-opener --repo <that checkout>\n' +
          '  or drop --via-host to open it as the app instead',
      );
    }
    const id = writeRequest(dir, {
      repo,
      head,
      base: base ?? 'main',
      title,
      body: body ?? '',
      draft: args.has('draft'),
      session: 'pr',
      pid: process.pid,
    });
    const answer = await waitForResult(dir, id, ANSWER_TIMEOUT_MS);
    removeResult(dir, id);
    if (answer === undefined) {
      fail(
        `the host opener did not answer ${id} within ${Math.round(ANSWER_TIMEOUT_MS / 1000)}s\n` +
          '  it may still be working: the request is not cancelled, and the opener removes it only once\n' +
          '  it has created the pull request or failed. Check the pull request list before asking again.',
      );
    }
    if (answer.error !== undefined) fail(`the host opener could not open it: ${answer.error}`);
    say(`opened #${answer.number ?? '?'} (as you, through the host opener): ${answer.url ?? '(no url)'}`);
    return 0;
  }

  if (socketPath === undefined) {
    fail('no broker socket: pass --socket, set GIT_BROKER_SOCKET, or run `git-credential-broker setup`');
  }

  let response;
  try {
    response = await requestOverSocket(
      socketPath,
      {
        v: 1,
        op: 'pull-request',
        host,
        path: repo,
        action,
        ...(number === undefined ? {} : { number: Number(number) }),
        ...(action === 'reply' ? { commentId: Number(replyTo) } : {}),
        ...(action === 'resolve' ? { threadId: args.value('resolve') } : {}),
        ...(head === undefined ? {} : { head }),
        ...(base === undefined ? {} : { base }),
        ...(title === undefined ? {} : { title }),
        ...(body === undefined ? {} : { body }),
        ...(action === 'merge' ? { method: args.value('method') ?? 'squash' } : {}),
        draft: args.has('draft'),
        session: 'pr',
        pid: process.pid,
      },
      PR_TIMEOUT_MS,
    );
  } catch (error) {
    process.stderr.write(`unreachable: ${(error as Error).message}\n`);
    return 3;
  }

  if (!response.ok) {
    process.stderr.write(`refused [${response.code ?? 'unknown'}]: ${response.reason ?? 'no reason given'}\n`);
    return 1;
  }

  if (action === 'status' || action === 'threads' || action === 'resolve') {
    say(response.prStatus ?? 'no report');
    return 0;
  }

  const done =
    action === 'open'
      ? 'opened'
      : action === 'close'
        ? 'closed'
        : action === 'merge'
          ? 'merged'
          : action === 'comment'
            ? 'commented on'
            : action === 'reply'
              ? 'replied in'
              : 'updated';
  const state = response.prState === undefined ? '' : ` (${response.prState})`;
  say(`${done} #${response.prNumber ?? '?'}${state}: ${response.prUrl ?? '(no url)'}`);
  return 0;
}
