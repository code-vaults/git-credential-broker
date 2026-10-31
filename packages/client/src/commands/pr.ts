/**
 * `pr` — open, update or inspect one pull request through the broker.
 *
 * `pr <subcommand>` runs as the catalogued gh action when the catalog has one (`pr:view`,
 * `pr:close`, …); this file is the flag-only lifecycle for the actions gh cannot express.
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
  LOGIN,
  channelDir,
  findGitDir,
  readOpener,
  removeResult,
  waitForResult,
  writeRequest,
} from 'gcb-core';
import { requestOverSocket, resolveSocketPath } from '../helper.ts';
import { baseBranchFor, qualifiedBranch, remoteRepo } from './remotes.ts';
import { runGh } from './gh.ts';
import { fail, parseArgs, say } from 'gcb-core';

/** Every flag the flag-only lifecycle understands. */
const KNOWN_FLAGS = new Set([
  'help', 'h', 'draft', 'close', 'comment', 'file', 'line', 'side', 'threads',
  'reply-to', 'edit', 'resolve', 'id', 'jq', 'proxy', 'no-proxy', 'socket', 'host', 'repo',
  'head', 'base', 'title', 'body', 'body-file', 'number', 'as-user', 'via-host', 'status',
]);

/** Longer than a credential request: a token is minted, then the action is performed. */
const PR_TIMEOUT_MS = 60_000;

/** Usage text for `pr`. */
export const PR_USAGE = `Usage: gcb pr [options]

Open, update or inspect a pull request through the broker, without the credential
ever reaching this side.

A subcommand the gh action catalog has (pr view, pr close, …) runs as that action instead;
gcb gh --help lists them. The flags below are the flag-only lifecycle gh cannot express.

Opening (the default)
  --head <branch>      The branch holding the change                 [required]
                       May be <remote>:<branch>, e.g. origin:feat/x, to name a fork
  --base <branch>      The branch to merge into (default: main)
                       A <remote>:<branch> here names the same repository as --repo
  --title <text>       The title                                     [required]
  --body <text>        The body, inline
  --body-file <path>   The body, read from a file — a pull request body is usually long
  --draft              Open it as a draft
  --as-user            Act as the authorized person through the broker; fails if no
                       user token is configured. Without this flag the creation uses
                       the app's installation token
  --as-user <login>    Create it through the host opener, using ~/.config/gh-<login>
                       (run 'gcb host-opener' on the host)

Acting on one
  --number <n>         The pull request number                       [required]
  --proxy <url>        Use this proxy for this request
  --no-proxy           Reach GitHub directly for this request
  --status             Report its state, mergeability and the runs for its commit
  --comment            Post an anchored review comment (also needs --file and --line);
                       for a plain comment use: gcb gh pr comment <number> --body ...
  --file <path>        Anchor that comment to a line of this file, repository-relative
  --line <n>           The line to anchor to, in the new file unless --side says otherwise
  --side <left|right>  Which side of the diff --line counts on (default: right)
  --threads            List its review threads: their ids, whether they are resolved, and the comments
  --reply-to <id>      Reply inside the thread that comment id belongs to, with --body/--body-file
  --edit <id>          Replace the body of that review comment, with --body/--body-file
                       (an id --threads prints; no --number is needed)
  --resolve <thread>   Mark that review thread resolved (the id --threads prints)
  --id <review-id>     Show one existing review (with --number)
  --jq <expr>          Filter that review's JSON (with --id)
  With --number and none of the above, the title, body or base is updated.

Common
  --socket <path>      Broker socket (default: $GIT_BROKER_SOCKET or the socket file)
  --host <host>        Host as configured, e.g. github.com (default: github.com)
  --repo <owner/name>  Repository the pull request belongs to (default: origin remote)
  -h, --help           Show this help
`;


/** A positive decimal identifier that survives Number() without losing precision. */
const isPositiveSafeInteger = (value: string | undefined): value is string =>
  value !== undefined && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));

/**
 * Read the action out of the flags.
 *
 * @param args - the parsed arguments.
 * @returns the selected action; `--id` is applied by the caller as `review`.
 */
function actionOf(args: { has(name: string): boolean; value(name: string): string | undefined }) {
  // `--resolve`, `--reply-to` and `--edit` take a value, and a bare one is parsed as a boolean flag with
  // no value at all. Selecting the action from the flag's *presence* is what turns that into the refusal
  // below — reading only `value` let a bare `--edit` fall through to `update`, which patched the pull
  // request itself with the body meant for the comment.
  const present = (name: string): boolean => args.has(name) || args.value(name) !== undefined;
  if (present('resolve')) return 'resolve' as const;
  if (present('reply-to')) return 'reply' as const;
  if (present('edit')) return 'edit' as const;
  if (args.has('threads')) return 'threads' as const;
  if (args.has('comment')) return 'comment' as const;
  if (args.has('status')) return 'status' as const;
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
    booleans: ['help', 'draft', 'status', 'comment', 'threads', 'no-proxy'],
  });
  if (args.has('help') || args.has('h')) {
    say(PR_USAGE);
    return 0;
  }
  if (args.has('via-host') || args.value('via-host') !== undefined) {
    fail('--via-host was replaced by --as-user <login>');
  }
  // Unknown options are refused rather than ignored: a typo must not silently fall through to an update.
  for (const name of args.names) {
    if (!KNOWN_FLAGS.has(name)) fail('unknown option --' + name + ' for gcb pr');
  }
  if (args.positionals.length > 0) fail('unexpected argument ' + JSON.stringify(args.positionals[0]) + ' for gcb pr');

  // Before --repo: the point of the message is to name the command that does it now.
  if (args.has('close') || args.value('close') !== undefined) {
    fail('--close moved to: gcb gh pr close <number> --repo owner/name');
  }
  // Before --repo too: a bare `gcb pr --comment` should hear what the flag needs, not that --repo
  // is missing. An anchored comment (--file and --line) is still this command's to post.
  if (args.has('comment') && args.value('file') === undefined && args.value('line') === undefined) {
    fail('--comment only posts an anchored review comment; pass --file and --line');
  }

  if (args.has('no-proxy') && args.value('proxy') !== undefined) {
    fail('--proxy and --no-proxy are mutually exclusive');
  }
  if (args.has('proxy') && args.value('proxy') === undefined) fail('--proxy needs a value');
  const proxy = args.has('no-proxy') ? null : args.value('proxy');
  const socketPath = resolveSocketPath(args.value('socket'), process.env);
  const looksLikeOption = (value: string): boolean =>
    value.startsWith('--') || /^-(?=[A-Za-z])/.test(value);
  const invalidValue = (name: string): boolean =>
    args.has(name) || args.values(name).some((value) => value.trim() === '' || looksLikeOption(value));
  const hasValue = (name: string): boolean => args.has(name) || args.values(name).length > 0;
  const hostArg = args.value('host');
  if (hasValue('host') && invalidValue('host')) fail('--host needs a value (e.g. github.com)');
  const host = hostArg ?? 'github.com';
  const repoArg = args.value('repo');
  if (hasValue('repo') && invalidValue('repo')) fail('--repo needs a value (e.g. owner/name)');
  let repo = repoArg;
  if (repo === undefined) {
    const found = remoteRepo('origin', process.cwd());
    if (found === undefined) fail('--repo is required when the checkout has no usable origin remote');
    if (found.host !== host.toLowerCase()) {
      fail(`the checkout's remote is on ${found.host}, but --host is ${host}; pass --repo or --host`);
    }
    repo = `${found.owner}/${found.repo}`;
  }
  if (repo.trim() === '') fail('--repo needs a value (e.g. owner/name)');
  let action: ReturnType<typeof actionOf> | 'review' = actionOf(args);
  const hasReviewId = args.has('id') || args.value('id') !== undefined;
  if (hasReviewId) {
    const conflicts = [
      'status', 'comment', 'threads', 'reply-to', 'edit', 'resolve', 'close', 'draft', 'as-user',
      'head', 'base', 'title', 'body', 'body-file', 'file', 'line', 'side',
    ];
    if (conflicts.some((name) => args.has(name) || args.value(name) !== undefined) || (action !== 'update' && action !== 'open')) {
      fail('--id only goes with --number and --jq');
    }
    action = 'review';
  }
  const accounts = args.values('as-user');
  const asUser = args.has('as-user');
  if (accounts.length > 1) fail('--as-user may only be given once');
  if (asUser && accounts.length > 0) fail('--as-user may only be given once');
  const account = accounts[0];
  if (account !== undefined && action !== 'open') {
    fail('--as-user only creates a pull request through the opener, so it does not go with ' + JSON.stringify(action));
  }
  if (asUser && action !== 'open' && action !== 'resolve') {
    fail('--as-user without a login only opens or resolves a pull request, so it does not go with ' + JSON.stringify(action));
  }
  if (account !== undefined && !LOGIN.test(account)) {
    fail(`--as-user must be a GitHub login or no value, got ${JSON.stringify(account)}`);
  }
  const identity = asUser || action === 'resolve' ? 'user' : 'app';

  const number = args.value('number');
  // `--head origin:feat/x` and `--base upstream:main` name a configured remote instead of a repository
  // typed by hand: it is the name this checkout already pushes to, and a typo lists the ones that exist.
  // The base is a branch of the repository --repo names, so the owner a remote resolves to is a check
  // rather than part of the value: sending `owner:branch` as a base names a branch that cannot exist.
  const baseBranch = (): string | undefined => {
    const raw = args.value('base');
    if (raw === undefined) return undefined;
    try {
      return baseBranchFor(raw, repo, process.cwd());
    } catch (error) {
      fail((error as Error).message);
    }
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
  } else if (action !== 'resolve' && action !== 'edit' && number === undefined) {
    const verb = action === 'status' ? 'inspect' : action;
    fail(`--number is required to ${verb} a pull request`);
  }
  // `--resolve` and `--edit` name their target by id and need no pull request number, but one given
  // anyway still has to be a number.
  if (number !== undefined && !isPositiveSafeInteger(number)) {
    fail(`--number must be a positive integer, got ${JSON.stringify(number)}`);
  }
  const jq = args.value('jq');
  if ((args.has('jq') && jq === undefined) || (jq !== undefined && jq.trim() === '')) {
    fail('--jq needs an expression');
  }
  if (jq !== undefined && action !== 'review') {
    fail('--jq only goes with --id');
  }
  if (action === 'update' && title === undefined && body === undefined && base === undefined) {
    fail('an update has to change something: pass --title, --body/--body-file or --base');
  }
  if ((action === 'comment' || action === 'reply' || action === 'edit') && (body === undefined || body.trim() === '')) {
    fail('a comment has to say something: pass --body or --body-file');
  }

  const filePath = args.value('file');
  const lineArg = args.value('line');
  const side = (args.value('side') ?? 'right').toLowerCase();
  if ((filePath === undefined) !== (lineArg === undefined)) {
    fail('an anchored comment needs both --file and --line, or neither');
  }
  if (filePath !== undefined) {
    if (action !== 'comment') fail('--file and --line anchor a comment, so they only go with --comment');
    if (!Number.isInteger(Number(lineArg)) || Number(lineArg) <= 0) {
      fail(`--line must be a positive integer, got ${JSON.stringify(lineArg)}`);
    }
    if (side !== 'left' && side !== 'right') {
      fail(`--side must be left or right, got ${JSON.stringify(args.value('side'))}`);
    }
  }
  const replyTo = args.value('reply-to');
  if (action === 'reply' && (replyTo === undefined || !Number.isInteger(Number(replyTo)) || Number(replyTo) <= 0)) {
    fail(`--reply-to needs the id of the comment being answered, got ${JSON.stringify(replyTo)}`);
  }
  const editId = args.value('edit');
  if (action === 'edit' && (editId === undefined || !Number.isInteger(Number(editId)) || Number(editId) <= 0)) {
    fail(`--edit needs the id of the review comment being changed, got ${JSON.stringify(editId)}`);
  }
  const reviewId = args.value('id');
  if (action === 'review' && !isPositiveSafeInteger(reviewId)) {
    fail(`--id needs a positive review id, got ${JSON.stringify(reviewId)}`);
  }
  const resolveId = args.value('resolve');
  if (action === 'resolve' && (resolveId === undefined || resolveId.trim() === '')) {
    fail(`--resolve needs the id of the thread being resolved, got ${JSON.stringify(resolveId)}`);
  }

  if (action === 'review') {
    const ghArgs = ['pr', 'review-by-id', String(number), reviewId as string, '--repo', repo, '--host', host];
    const socketArg = args.value('socket');
    if (socketArg !== undefined) ghArgs.push('--socket', socketArg);
    if (args.has('no-proxy')) ghArgs.push('--no-proxy');
    else if (args.value('proxy') !== undefined) ghArgs.push('--proxy', args.value('proxy') as string);
    if (jq !== undefined) ghArgs.push('--jq', jq);
    return runGh(ghArgs, { unreachableExitCode: 3 });
  }

  if (action === 'update') {
    const ghArgs = ['pr', 'edit', String(number), '--repo', repo, '--host', host];
    if (title !== undefined) ghArgs.push(`--title=${title}`);
    if (body !== undefined) ghArgs.push(`--body=${body}`);
    if (base !== undefined) ghArgs.push(`--base=${base}`);
    const socketArg = args.value('socket');
    if (socketArg !== undefined) ghArgs.push('--socket', socketArg);
    if (args.has('no-proxy')) ghArgs.push('--no-proxy');
    else if (args.value('proxy') !== undefined) ghArgs.push('--proxy', args.value('proxy') as string);
    return runGh(ghArgs, { unreachableExitCode: 3 });
  }

  if (account !== undefined) {
    if (head === undefined || title === undefined) fail('--as-user needs --head and --title');
    const gitDir = findGitDir(process.cwd());
    if (gitDir === undefined) fail('--as-user needs a git repository: run it from the checkout');
    const dir = channelDir(gitDir);
    if (readOpener(dir) === undefined) {
      fail(
        `no host opener is watching ${dir}\n` +
          '  start one on the host: gcb host-opener --repo <that checkout>\n' +
          '  or drop --as-user to open it as the app instead',
      );
    }
    // writeRequest refuses a request the opener would have to refuse: a title past its limit, a body past
    // its limit, a head equal to its base. It throws, and a stack trace tells the caller none of that.
    let id: string;
    try {
      id = writeRequest(dir, {
        repo,
        head,
        base: base ?? 'main',
        title,
        body: body ?? '',
        draft: args.has('draft'),
        proxy,
        account,
        session: 'pr',
        pid: process.pid,
      });
    } catch (error) {
      fail((error as Error).message);
    }
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
    say(
      `opened #${answer.number ?? '?'} (as ${account}, through the host opener): ${answer.url ?? '(no url)'}`,
    );
    return 0;
  }

  if (socketPath === undefined) {
    fail('no broker socket: pass --socket, set GIT_BROKER_SOCKET, or run `gcb setup`');
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
        identity,
        ...(number === undefined || action === 'edit' ? {} : { number: Number(number) }),
        ...(action === 'reply' ? { commentId: Number(replyTo) } : {}),
        ...(action === 'edit' ? { commentId: Number(editId) } : {}),
        ...(action === 'resolve' ? { threadId: args.value('resolve') } : {}),
        ...(head === undefined ? {} : { head }),
        ...(base === undefined ? {} : { base }),
        ...(title === undefined ? {} : { title }),
        ...(body === undefined ? {} : { body }),
        ...(filePath === undefined ? {} : { filePath, line: Number(lineArg), side }),
        draft: args.has('draft'),
        session: 'pr',
        pid: process.pid,
        proxy,
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
      : action === 'comment'
            ? 'commented on'
            : action === 'reply'
              ? 'replied in'
              : action === 'edit'
                ? 'edited a review comment on'
                : 'updated';
  const state = response.prState === undefined ? '' : ` (${response.prState})`;
  say(`${done} #${response.prNumber ?? '?'}${state}: ${response.prUrl ?? '(no url)'}`);
  return 0;
}
