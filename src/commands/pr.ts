/**
 * `pr` — open one pull request through the broker.
 *
 * The credential never leaves the broker. The broker mints a token narrowed to `pull_requests: write`
 * plus read access to the branches it names, posts the request itself, and answers with the number
 * and the URL: the agent gets a pull request without ever holding something that could push.
 *
 * Exit codes: 0 opened, 1 refused, 3 broker unreachable.
 */
import { readFileSync } from 'node:fs';

import { requestOverSocket, resolveSocketPath } from '../helper.ts';
import { fail, parseArgs, say } from './support.ts';

/** Longer than a credential request: a token is minted, then the request is posted. */
const PR_TIMEOUT_MS = 60_000;

/** Usage text for `pr`. */
export const PR_USAGE = `Usage: git-credential-broker pr [options]

Open a pull request through the broker, without the credential ever reaching this side.

  --socket <path>      Broker socket (default: $GIT_BROKER_SOCKET or the socket file)
  --host <host>        Host as configured, e.g. github.com           [required]
  --repo <owner/name>  Repository the branches belong to             [required]
  --head <branch>      The branch holding the change                 [required]
  --base <branch>      The branch to merge into (default: main)
  --title <text>       The title                                     [required]
  --body <text>        The body, inline
  --body-file <path>   The body, read from a file — a pull request body is usually long
  --draft              Open it as a draft
  -h, --help           Show this help
`;

/**
 * Run the `pr` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code: 0 opened, 1 refused, 3 unreachable.
 */
export async function runPr(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help', 'draft'] });
  if (args.has('help') || args.has('h')) {
    say(PR_USAGE);
    return 0;
  }

  const socketPath = resolveSocketPath(args.value('socket'), process.env);
  const host = args.value('host');
  const repo = args.value('repo');
  const head = args.value('head');
  const title = args.value('title');
  if (!socketPath) {
    fail('no broker socket: pass --socket, set GIT_BROKER_SOCKET, or run `git-credential-broker setup`');
  }
  if (!host) fail('--host is required (e.g. github.com)');
  if (!repo) fail('--repo is required (e.g. owner/name)');
  if (!head) fail('--head is required (the branch holding the change)');
  if (!title) fail('--title is required');

  const bodyFile = args.value('body-file');
  let body = args.value('body') ?? '';
  if (bodyFile !== undefined) {
    try {
      body = readFileSync(bodyFile, 'utf8');
    } catch (error) {
      fail(`cannot read ${bodyFile}: ${(error as Error).message}`);
    }
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
        head,
        base: args.value('base') ?? 'main',
        title,
        body,
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

  say(`opened #${response.prNumber ?? '?'}: ${response.prUrl ?? '(no url)'}`);
  return 0;
}
