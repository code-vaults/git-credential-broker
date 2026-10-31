/**
 * `issue` — catalogued issue actions, plus `create --as-user` through the host opener.
 *
 * Without `--as-user` this is a thin wrapper: the catalogued `issue:create` action runs through the app
 * broker like every other gh action. With `--as-user` the request goes to the host opener, because the
 * app may not be installed on the repository and a person's account is the only route that can create
 * an issue there.
 */
import { readFileSync } from 'node:fs';

import { LOGIN } from 'gcb-core';
import { fail, parseArgs, say } from 'gcb-core';

import { runGh } from './gh.ts';
import { submitToOpener } from './host-submit.ts';

/** Every flag the `--as-user` create path understands. */
const KNOWN_FLAGS = new Set([
  'help', 'h', 'title', 'body', 'body-file', 'repo', 'as-user', 'proxy', 'no-proxy',
]);

/** Usage text for the host-opener create path. */
export const ISSUE_USAGE = `Usage: gcb issue create --as-user <login> [options]

Create an issue as a person through the host opener. Without --as-user, issue actions run
through the app broker as usual.

  --title <text>       The title                                     [required]
  --body <text>        The body, inline
  --body-file <path>   The body, read from a file
  --repo <owner/name>  Recorded for the request; the checkout decides the repository
  --as-user <login>    Use ~/.config/gh-<login> on the host
  --proxy <url>        Use this proxy for the opener's gh call
  --no-proxy           Reach GitHub directly for the opener's gh call
  -h, --help           Show this help

The broker route (no --as-user) takes --body and catalogued flags such as --label/--assignee;
this host route takes --body/--body-file only.
`;

/**
 * Run one `issue` command.
 *
 * @param argv - arguments after `issue`.
 * @returns the process exit code.
 */
export async function runIssue(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help', 'no-proxy'] });
  if (args.has('help') || args.has('h')) {
    say(ISSUE_USAGE);
    return 0;
  }
  const account = args.values('as-user')[0];
  if (args.has('as-user')) fail('--as-user needs a GitHub login');
  if (args.values('as-user').length > 1) fail('--as-user may only be given once');
  if (args.positionals[0] !== 'create') {
    if (account !== undefined) fail('--as-user only creates an issue');
    return runGh(['issue', ...argv]);
  }
  if (account === undefined) return runGh(['issue', ...argv]);
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

  return submitToOpener(
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
  return 0;
}
