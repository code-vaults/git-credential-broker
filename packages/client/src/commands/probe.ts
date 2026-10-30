/**
 * `probe` — ask the broker what it would do for one repository, without pushing.
 *
 * Exercises the real path (JWT, installation lookup, permission pre-flight, token mint) and
 * reports the decision with the credential reduced to a fingerprint, so the output is safe to
 * paste anywhere. Exit codes: 0 allowed, 1 denied, 3 broker unreachable.
 */
import { tokenFingerprint } from 'gcb-core';
import { requestOverSocket, resolveSocketPath } from '../helper.ts';
import { fail, parseArgs, say } from 'gcb-core';

/** Usage text for `probe`. */
export const PROBE_USAGE = `Usage: gcb probe [options]

Ask the broker for a credential without pushing. Prints a fingerprint, never the credential.

  --socket <path>   Broker socket (default: $GIT_BROKER_SOCKET or the socket file)
  --host <host>     Host as git reports it (default: github.com)
  --repo <owner/name>  Repository path                            [required]
  --protocol <p>    https (default) or http for a host that opted in
  --proxy <url>     Use this proxy for this request
  --no-proxy        Reach GitHub directly for this request
  -h, --help        Show this help
`;

/**
 * Run the `probe` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code: 0 allowed, 1 denied, 3 unreachable.
 */
export async function runProbe(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help', 'no-proxy'] });
  if (args.has('no-proxy') && args.value('proxy') !== undefined) fail('--proxy and --no-proxy are mutually exclusive');
  if (args.has('proxy') && args.value('proxy') === undefined) fail('--proxy needs a value');
  const proxy = args.has('no-proxy') ? null : args.value('proxy');
  if (args.has('help') || args.has('h')) {
    say(PROBE_USAGE);
    return 0;
  }

  const socketPath = resolveSocketPath(args.value('socket'), process.env);
  const host = args.value('host') ?? 'github.com';
  const repo = args.value('repo');
  if (!socketPath) {
    fail('no broker socket: pass --socket, set GIT_BROKER_SOCKET, or run `gcb setup`');
  }
  if (!repo) fail('--repo is required (e.g. owner/name)');

  const protocol = args.value('protocol') ?? 'https';
  let response;
  try {
    response = await requestOverSocket(socketPath, {
      v: 1,
      op: 'credential',
      protocol,
      host,
      path: repo,
      proxy,
      session: 'probe',
      pid: process.pid,
    });
  } catch (error) {
    process.stderr.write(`unreachable: ${(error as Error).message}\n`);
    return 3;
  }

  if (!response.ok) {
    process.stderr.write(`denied [${response.code ?? 'unknown'}]: ${response.reason ?? 'no reason given'}\n`);
    return 1;
  }

  const password = response.password ?? '';
  say(`allowed: ${host}/${repo} over ${protocol}`);
  say(`  username      : ${response.username ?? '(none)'}`);
  say(`  expires_at    : ${response.expires_at ?? '(unknown)'}`);
  say(
    `  credential    : ${
      password ? `present, fingerprint ${tokenFingerprint(password)} (value not printed)` : 'MISSING'
    }`,
  );
  return 0;
}
