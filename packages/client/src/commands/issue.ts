/**
 * `issue` — catalogued create/edit/comment actions, with person routes through the host broker.
 *
 * Without `--as-user` these run app identity. Bare `--as-user` keeps the catalog action with the user
 * identity. `--as-user <login>` writes a typed request for the host broker, which is also the route for
 * a repository the app is not installed on.
 */
import { readFileSync } from 'node:fs';

import { LOGIN } from 'gcb-core';
import { fail, parseArgs, say, validateArgs } from 'gcb-core';

import { runGh } from './gh.ts';
import { remoteRepo } from './remotes.ts';
import { submitToHostBroker } from './host-submit.ts';

/** Every flag the `--as-user` create path understands. */
const KNOWN_FLAGS = new Set([
  'help', 'h', 'title', 'body', 'body-file', 'repo', 'host', 'as-user', 'proxy', 'no-proxy',
]);

/** Usage text for the host broker create path. */
export const ISSUE_USAGE = `Usage: gcb issue create|edit|comment [--as-user] [options]

Create, edit or comment on an issue. Without --as-user it runs through the app broker; bare
--as-user uses the broker's authorized person; --as-user <login> writes a request for the host
broker. issue edit <number> and issue comment <number> take the issue number as a positional.

  --title <text>       The title (create/edit)
  --body <text>        The body, inline, or use --body-file
  --body-file <path>   The body, read from a file
  --repo <owner/name>  The repository; with --as-user <login> it must be in the
                       broker allowlist and needs no checkout of its own
  --as-user            Use the broker's authorized person
  --as-user <login>    Use ~/.config/gh-<login> on the host
  --proxy <url>        Use this proxy for the host broker's gh call
  --no-proxy           Reach GitHub directly for the host broker's gh call
  -h, --help           Show this help

The broker route (no --as-user or bare) takes --body/--body-file and catalogued flags such as
--label/--assignee; the host route takes --body/--body-file, plus --title for edit.
`;

/**
 * Run one `issue` command.
 *
 * The catalogue paths are dispatched by `index.ts`; this module only owns the host-login route and
 * the issue usage. That keeps one forwarding layer, not two.
 *
 * @param argv - arguments after `issue`.
 * @returns the process exit code.
 */
export async function runIssue(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help', 'no-proxy'], optionalValues: ['as-user'] });
  if (args.values('as-user').length > 1) fail('--as-user may only be given once');
  if (args.has('as-user') && args.values('as-user').length > 0) {
    fail('--as-user cannot be both bare and given a login');
  }
  if (args.has('no-proxy') && (args.has('proxy') || args.values('proxy').length > 0)) {
    fail('--proxy and --no-proxy are mutually exclusive');
  }
  const account = args.values('as-user')[0];
  const command = args.positionals[0];
  if (
    validateArgs(
      args,
      argv,
      account === undefined ? undefined : KNOWN_FLAGS,
      account === undefined || command === undefined ? undefined : `gcb issue ${command} --as-user`,
    )
  ) {
    if (command === undefined || command === 'create') {
      say(ISSUE_USAGE);
      return 0;
    }
    return runGh(['issue', command, '--help']);
  }
  if (command === undefined) {
    if (validateArgs(args, argv, KNOWN_FLAGS, 'gcb issue')) {
      say(ISSUE_USAGE);
      return 0;
    }
    if (args.has('as-user')) fail('--as-user without a login only creates, edits or comments on an issue');
    say(ISSUE_USAGE);
    return 0;
  }
  if (account === undefined) {
    fail('--as-user <login> is required for the host broker route');
  }
  if (!LOGIN.test(account)) fail(`--as-user must be a GitHub login, got ${JSON.stringify(account)}`);
  if (command !== 'create' && command !== 'edit' && command !== 'comment') {
    fail('--as-user <login> only creates, edits or comments on an issue');
  }
  if (args.positionals.length > 2) fail('unexpected argument ' + JSON.stringify(args.positionals[2]));

  let number: number | undefined;
  if (command !== 'create') {
    const rawNumber = args.positionals[1];
    if (
      rawNumber === undefined ||
      !/^[1-9][0-9]*$/.test(rawNumber) ||
      !Number.isSafeInteger(Number(rawNumber))
    ) {
      fail('gcb issue ' + command + ' needs a safe positive issue number');
    }
    number = Number(rawNumber);
  } else if (args.positionals.length > 1) {
    fail('unexpected argument ' + JSON.stringify(args.positionals[1]));
  }
  if (
    command === 'edit' &&
    args.value('title') === undefined &&
    args.value('body') === undefined &&
    args.value('body-file') === undefined
  ) {
    fail('issue edit needs --title, --body or --body-file');
  }
  if (command === 'comment' && args.value('title') !== undefined) {
    fail('--title is only supported for issue edit');
  }
  if (command === 'create' && (args.has('host') || args.value('host') !== undefined)) {
    fail('--host is not supported for issue create; use the checkout remote');
  }

  const repoArg = args.value('repo');
  if ((args.has('repo') || args.values('repo').length > 0) && (repoArg === undefined || repoArg.trim() === '')) {
    fail('--repo needs a value');
  }
  const hostArg = args.value('host');
  let repo = repoArg;
  let host = hostArg;
  if (command !== 'create' && repo === undefined) {
    const found = remoteRepo('origin', process.cwd());
    if (found === undefined) fail('--as-user <login> needs --repo for issue edit or comment');
    if (host !== undefined && found.host !== host.toLowerCase()) {
      fail(`the checkout's remote is on ${found.host}, but --host is ${host}; pass --repo or --host`);
    }
    repo = `${found.owner}/${found.repo}`;
    host = host ?? found.host;
  }
  host ??= 'github.com';

  const bodyArg = args.value('body');
  const bodyFile = args.value('body-file');
  if (bodyArg !== undefined && bodyFile !== undefined) {
    fail('--body and --body-file are mutually exclusive');
  }
  let body = bodyArg;
  if (bodyFile !== undefined) {
    try {
      body = readFileSync(bodyFile, 'utf8');
    } catch (error) {
      fail(`cannot read ${bodyFile}: ${(error as Error).message}`);
    }
  }

  const common = {
    ...(repo === undefined ? {} : { repo }),
    host,
    account,
    proxy: args.has('no-proxy') ? null : args.value('proxy'),
    session: 'issue',
    pid: process.pid,
  };
  const success = (answer: { number?: number; url?: string }): string =>
    (command === 'create' ? 'opened issue #' : command === 'edit' ? 'edited issue #' : 'commented on issue #') +
    `${answer.number ?? '?'} as ${account}${answer.url === undefined ? '' : `: ${answer.url}`}`;

  if (command === 'create') {
    const title = args.value('title');
    if (title === undefined) fail('--title is required to create an issue');
    return submitToHostBroker(
      { kind: 'issue', ...common, title, body: body ?? '' },
      success,
    );
  }
  if (command === 'edit') {
    return submitToHostBroker(
      {
        kind: 'issue-edit',
        ...common,
        repo: repo as string,
        number: number as number,
        ...(args.value('title') === undefined ? {} : { title: args.value('title') as string }),
        ...(body === undefined ? {} : { body }),
      },
      success,
    );
  }
  return submitToHostBroker(
    { kind: 'issue-comment', ...common, repo: repo as string, number: number as number, body: body ?? '' },
    success,
  );
}
