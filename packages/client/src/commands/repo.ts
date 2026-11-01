/**
 * `repo` — repo-level actions that need a person.
 *
 * `repo fork` is the one operation an app cannot perform for itself: a fork must be owned by a user
 * account, and an installation token has none. The command therefore requires `--as-user`; bare
 * selects the broker's authorized person, a login selects the host opener.
 */
import { LOGIN, REPOSITORY } from 'gcb-core';
import { fail, parseArgs, say } from 'gcb-core';

import { requestOverSocket, resolveSocketPath } from '../helper.ts';
import { remoteRepo } from './remotes.ts';
import { submitToOpener } from './host-submit.ts';

const KNOWN_FLAGS = new Set([
  'help', 'h', 'as-user', 'proxy', 'no-proxy', 'socket', 'host',
]);

export const REPO_USAGE = `Usage: gcb repo fork [owner/name] [options]

Create a fork under a person's account. The app identity cannot own a fork, so --as-user is
required. Without an owner/name the source comes from the checkout's origin remote.

  --as-user            Use the broker's authorized user token
  --as-user <login>    Use the host opener with ~/.config/gh-<login>
  --host <host>        Host as configured (default: github.com or the origin remote's host)
  --socket <path>      Broker socket (default: GIT_BROKER_SOCKET)
  --proxy <url>        Use this proxy for this request
  --no-proxy           Reach GitHub directly for this request
  -h, --help           Show this help
`;

export async function runRepo(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help', 'no-proxy'] });
  if (args.has('help') || args.has('h')) {
    say(REPO_USAGE);
    return 0;
  }
  if (args.positionals[0] !== 'fork') fail('usage: gcb repo fork [owner/name]');
  if (args.positionals.length > 2) fail('unexpected argument ' + JSON.stringify(args.positionals[2]));
  for (const name of args.names) {
    if (!KNOWN_FLAGS.has(name)) fail('unknown option --' + name + ' for gcb repo fork');
  }

  const accounts = args.values('as-user');
  const asUser = args.has('as-user');
  if (accounts.length > 1) fail('--as-user may only be given once');
  if (asUser && accounts.length > 0) fail('--as-user cannot be both bare and given a login');
  // `--as-user acme/widget` is an unambiguous source repository, not an account: a login cannot
  // contain a slash. It saves making the positional depend on whether a bare flag was used.
  let account = accounts[0];
  let sourceFromAsUser: string | undefined;
  if (account !== undefined && REPOSITORY.test(account)) {
    sourceFromAsUser = account;
    account = undefined;
  }
  if (account !== undefined && !LOGIN.test(account)) {
    fail(`--as-user must be a GitHub login, a repository, or no value, got ${JSON.stringify(account)}`);
  }
  if (account === undefined && sourceFromAsUser === undefined && !asUser) {
    fail('--as-user is required for fork: the app identity cannot own a fork');
  }

  const proxyValues = args.values('proxy');
  if (args.has('proxy') && proxyValues.length === 0) fail('--proxy needs a value');
  if (args.has('no-proxy') && (args.has('proxy') || proxyValues.length > 0)) {
    fail('--proxy and --no-proxy are mutually exclusive');
  }
  const proxy = args.has('no-proxy') ? null : args.value('proxy');

  const origin = remoteRepo('origin', process.cwd());
  const source =
    sourceFromAsUser ?? args.positionals[1] ?? (origin === undefined ? undefined : `${origin.owner}/${origin.repo}`);
  if (source === undefined) fail('pass owner/name, or run this from a checkout with an origin remote');
  if (!REPOSITORY.test(source)) fail(`not a repository: ${JSON.stringify(source)}`);
  const hostValue = args.value('host');
  if (args.has('host') && (hostValue === undefined || hostValue.trim() === '')) fail('--host needs a value');
  const host = hostValue ?? origin?.host ?? 'github.com';

  if (account !== undefined) {
    return submitToOpener(
      { kind: 'fork', repo: source, host, account, proxy, session: 'repo', pid: process.pid },
      (answer) => `forked ${source} as ${account}: ${answer.url ?? '(no url)'}`,
    );
  }

  const socketPath = resolveSocketPath(args.value('socket'), process.env);
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
        path: source,
        action: 'fork',
        identity: 'user',
        session: 'repo',
        pid: process.pid,
        proxy,
      },
      60_000,
    );
  } catch (error) {
    process.stderr.write(`unreachable: ${(error as Error).message}\n`);
    return 3;
  }
  if (!response.ok) {
    process.stderr.write(`refused [${response.code ?? 'unknown'}]: ${response.reason ?? 'no reason given'}\n`);
    return 1;
  }
  if (response.prUrl === undefined) fail('the broker did not answer with a fork URL');
  say(`forked ${source}: ${response.prUrl}`);
  return 0;
}
