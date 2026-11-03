/**
 * `issue` — catalogued issue actions, plus `create --as-user` through the host broker.
 *
 * Without `--as-user` this is a thin wrapper: the catalogued `issue:create` action runs through the app
 * broker like every other gh action. With `--as-user` the request goes to the host broker, because the
 * app may not be installed on the repository and a person's account is the only route that can create
 * an issue there.
 */
import { readFileSync } from 'node:fs';

import { LOGIN } from 'gcb-core';
import { fail, parseArgs, say } from 'gcb-core';

import { runGh } from './gh.ts';
import { submitToHostBroker } from './host-submit.ts';

/** Every flag the `--as-user` create path understands. */
const KNOWN_FLAGS = new Set([
  'help', 'h', 'title', 'body', 'body-file', 'number', 'repo', 'as-user', 'proxy', 'no-proxy',
]);

/** Usage text for the host broker create path. */
export const ISSUE_USAGE = `Usage: gcb issue create|edit|comment [--as-user] [options]

Create, edit or comment on an issue. Without --as-user it runs through the app broker; bare
--as-user uses the broker's authorized person; for create, --as-user <login> writes a request for
the host broker.

  --title <text>       The title (create/edit)
  --body <text>        The body, inline, or use --body-file
  --number <n>         The issue to edit or comment on (edit/comment)
  --body-file <path>   The body, read from a file
  --repo <owner/name>  The repository; with --as-user <login> it must be in the
                       broker allowlist and needs no checkout of its own
  --as-user            Use the broker's authorized person
  --as-user <login>    Use ~/.config/gh-<login> on the host
  --proxy <url>        Use this proxy for the host broker's gh call
  --no-proxy           Reach GitHub directly for the host broker's gh call
  -h, --help           Show this help

The broker route (no --as-user or bare) takes --body/--body-file and catalogued flags such as
--label/--assignee; the host route takes --body/--body-file only.
`;

/** Drop one value-taking flag and its value, in either spelling. */
function dropFlag(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === `--${name}` || argument === `-${name}`) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) index += 1;
      continue;
    }
    if (argument?.startsWith(`--${name}=`) || argument?.startsWith(`-${name}=`)) continue;
    if (argument !== undefined) out.push(argument);
  }
  return out;
}

/** Translate --body-file into the catalogued --body value. */
function forwardBodyFile(argv: readonly string[], bodyFile: string): string[] {
  let body: string;
  try {
    body = readFileSync(bodyFile, 'utf8');
  } catch (error) {
    fail(`cannot read ${bodyFile}: ${(error as Error).message}`);
  }
  const rest = dropFlag(dropFlag(argv, 'body-file'), 'body');
  rest.push(`--body=${body}`);
  return rest;
}

/**
 * Run one `issue` command.
 *
 * @param argv - arguments after `issue`.
 * @returns the process exit code.
 */
export async function runIssue(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help', 'no-proxy'] });
  const account = args.values('as-user')[0];
  const command = args.positionals[0];
  if (command !== 'create') {
    if (account !== undefined) {
      if (command !== 'edit' && command !== 'comment') {
        fail('--as-user <login> only creates, edits or comments on an issue');
      }
      if (!LOGIN.test(account)) fail(`--as-user must be a GitHub login, got ${JSON.stringify(account)}`);
      for (const name of args.names) {
        if (!KNOWN_FLAGS.has(name)) fail('unknown option --' + name + ' for gcb issue ' + command + ' --as-user');
      }
      const number = args.positionals[1];
      if (number === undefined || !/^[1-9][0-9]*$/.test(number)) {
        fail('gcb issue ' + command + ' needs the issue number');
      }
      const repo = args.value('repo');
      if (repo === undefined || repo.trim() === '') {
        fail('--as-user <login> needs --repo for issue edit or comment');
      }
      let body = args.value('body');
      const bodyFile = args.value('body-file');
      if (bodyFile !== undefined) {
        try {
          body = readFileSync(bodyFile, 'utf8');
        } catch (error) {
          fail(`cannot read ${bodyFile}: ${(error as Error).message}`);
        }
      }
      if (command === 'comment' && (body === undefined || body.trim() === '')) {
        fail('issue comment needs --body or --body-file');
      }
      if (command === 'edit' && body === undefined && args.value('title') === undefined) {
        fail('issue edit needs --title, --body or --body-file');
      }
      const common = {
        repo,
        number: Number(number),
        account,
        proxy: args.has('no-proxy') ? null : args.value('proxy'),
        session: 'issue',
        pid: process.pid,
      };
      const success = (answer: { number?: number; url?: string }): string =>
        (command === 'edit' ? 'edited issue #' : 'commented on issue #') +
        `${answer.number ?? '?'} as ${account}${answer.url === undefined ? '' : `: ${answer.url}`}`;
      if (command === 'edit') {
        return submitToHostBroker(
          {
            kind: 'issue-edit',
            ...common,
            ...(args.value('title') === undefined ? {} : { title: args.value('title') as string }),
            ...(body === undefined ? {} : { body }),
          },
          success,
        );
      }
      return submitToHostBroker({ kind: 'issue-comment', ...common, body: body ?? '' }, success);
    }
    if (args.has('as-user') && command !== 'edit' && command !== 'comment') {
      fail('--as-user without a login only creates, edits or comments on an issue');
    }
    if (command === undefined && (args.has('help') || args.has('h'))) {
      say(ISSUE_USAGE);
      return 0;
    }
    let rest = args.has('as-user') ? argv.filter((argument) => argument !== '--as-user' && argument !== '-as-user') : [...argv];
    const bodyFile = args.value('body-file');
    if (bodyFile !== undefined) rest = forwardBodyFile(rest, bodyFile);
    return runGh(['issue', ...rest], args.has('as-user') ? { identity: 'user' } : {});
  }
  if (args.has('help') || args.has('h')) {
    say(ISSUE_USAGE);
    return 0;
  }
  if (args.values('as-user').length > 1) fail('--as-user may only be given once');
  if (args.has('as-user') && args.values('as-user').length > 0) {
    fail('--as-user cannot be both bare and given a login');
  }
  if (args.has('as-user')) {
    // Bare --as-user is the broker's authorized person; the action decides which token to use.
    let rest = argv.filter((argument) => argument !== '--as-user' && argument !== '-as-user');
    const bodyFile = args.value('body-file');
    if (bodyFile !== undefined) rest = forwardBodyFile(rest, bodyFile);
    return runGh(['issue', ...rest], { identity: 'user' });
  }
  if (account === undefined) {
    const bodyFile = args.value('body-file');
    return runGh(['issue', ...(bodyFile === undefined ? argv : forwardBodyFile(argv, bodyFile))]);
  }
  if (!LOGIN.test(account)) fail(`--as-user must be a GitHub login, got ${JSON.stringify(account)}`);
  for (const name of args.names) {
    if (!KNOWN_FLAGS.has(name)) fail('unknown option --' + name + ' for gcb issue create --as-user');
  }
  if (args.positionals.length > 1) fail('unexpected argument ' + JSON.stringify(args.positionals[1]));
  const proxyValues = args.values('proxy');
  if (args.has('proxy') && proxyValues.length === 0) fail('--proxy needs a value');
  if (args.has('no-proxy') && (args.has('proxy') || proxyValues.length > 0)) {
    fail('--proxy and --no-proxy are mutually exclusive');
  }
  const repo = args.value('repo');
  if ((args.has('repo') || args.values('repo').length > 0) && (repo === undefined || repo.trim() === '')) {
    fail('--repo needs a value (e.g. owner/name)');
  }

  const title = args.value('title');
  if (title === undefined) fail('--title is required to create an issue');
  const bodyFile = args.value('body-file');
  let body = args.value('body') ?? '';
  if (bodyFile !== undefined) {
    try {
      body = readFileSync(bodyFile, 'utf8');
    } catch (error) {
      fail(`cannot read ${bodyFile}: ${(error as Error).message}`);
    }
  }

  return submitToHostBroker(
    {
      kind: 'issue',
      ...(repo === undefined ? {} : { repo }),
      title,
      body,
      account,
      proxy: args.has('no-proxy') ? null : args.value('proxy'),
      session: 'issue',
      pid: process.pid,
    },
    (answer) => `opened issue #${answer.number ?? '?'} as ${account}: ${answer.url ?? '(no url)'}`,
  );
}
