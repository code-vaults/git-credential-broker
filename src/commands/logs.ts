/**
 * `logs` — read one workflow job's log through the broker.
 *
 * The credential never leaves the broker. The broker mints a read-only, single-repository token
 * narrowed to `actions: read`, fetches the log itself, and answers with the text: the agent gets the
 * log without ever holding something that could read anything else.
 *
 * Exit codes: 0 read, 1 refused, 3 broker unreachable.
 */
import { requestOverSocket, resolveSocketPath } from '../helper.ts';
import { fail, parseArgs, say } from './support.ts';

/**
 * How long to wait for the broker.
 *
 * Longer than a credential request: this is three API round trips (a token, a repository-scoped job
 * lookup, then the log), and the first one after a restart can be slow.
 */
const LOGS_TIMEOUT_MS = 60_000;

/** Usage text for `logs`. */
export const LOGS_USAGE = `Usage: git-credential-broker logs [options]

Read a workflow job log through the broker, without the credential ever reaching this side.

  --socket <path>      Broker socket (default: $GIT_BROKER_SOCKET or the socket file)
  --host <host>        Host as configured, e.g. github.com          [required]
  --repo <owner/name>  Repository the job belongs to                [required]
  --job <id>           Workflow job id, which is also the check run id   [required]
  -h, --help           Show this help
`;

/**
 * Run the `logs` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code: 0 read, 1 refused, 3 unreachable.
 */
export async function runLogs(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help'] });
  if (args.has('help') || args.has('h')) {
    say(LOGS_USAGE);
    return 0;
  }

  const socketPath = resolveSocketPath(args.value('socket'), process.env);
  const host = args.value('host');
  const repo = args.value('repo');
  const rawJob = args.value('job');
  if (!socketPath) {
    fail('no broker socket: pass --socket, set GIT_BROKER_SOCKET, or run `git-credential-broker setup`');
  }
  if (!host) fail('--host is required (e.g. github.com)');
  if (!repo) fail('--repo is required (e.g. owner/name)');
  if (!rawJob) fail('--job is required (the workflow job id, which is also the check run id)');
  const jobId = Number(rawJob);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    fail(`--job must be a positive integer, got ${JSON.stringify(rawJob)}`);
  }

  let response;
  try {
    response = await requestOverSocket(
      socketPath,
      {
        v: 1,
        op: 'logs',
        host,
        path: repo,
        jobId,
        session: 'logs',
        pid: process.pid,
      },
      LOGS_TIMEOUT_MS,
    );
  } catch (error) {
    process.stderr.write(`unreachable: ${(error as Error).message}\n`);
    return 3;
  }

  if (!response.ok) {
    process.stderr.write(`refused [${response.code ?? 'unknown'}]: ${response.reason ?? 'no reason given'}\n`);
    return 1;
  }

  if (response.truncated === true) {
    process.stderr.write('note: the broker truncated this log\n');
  }
  const text = response.log ?? '';
  process.stdout.write(text.endsWith('\n') || text === '' ? text : `${text}\n`);
  return 0;
}
