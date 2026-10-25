/**
 * `gh` — run one catalogued GitHub action through the broker.
 *
 * The action catalog defines the command, flags, positionals and permissions. The client only
 * parses names and values; the broker rebuilds the canonical argv and runs gh with its own token.
 */
import { getGhAction, parseArgs, say, fail, type ActionValues } from 'gcb-cli';

import { requestOverSocket, resolveSocketPath } from '../helper.ts';

/** Usage text for `gh`. */
export const GH_USAGE = `Usage: gcb gh <pr|issue|run> <command> [options]

Run a catalogued GitHub action through the broker.

Common
  --repo <owner/name>  Repository the action belongs to           [required]
  --host <host>        Host as configured, e.g. github.com (default: github.com)
  --socket <path>      Broker socket (default: GIT_BROKER_SOCKET)
  -h, --help           Show this help

Commands
  pr view <number> [--json fields] [--jq expr] [--comments]
  pr list [--state state] [--limit n] [--head branch] [--base branch] [--label label]
  pr diff <number> [--name-only] [--patch]
  pr create --head branch --title title --body text [--base branch] [--draft]
  pr comment <number> --body text
  pr review <number> (--approve | --request-changes | --comment) [--body text]
  issue create --title title --body text [--label label]
  run view <run-id> [--log] [--job id] [--json fields] [--jq expr]
  run list [--limit n] [--workflow name] [--branch branch]
`;

/**
 * Run the `gh` command.
 *
 * @param argv - arguments after `gh`.
 * @returns the process exit code: 0 success, 1 refusal.
 */
export async function runGh(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    say(GH_USAGE);
    return argv.length === 0 ? 1 : 0;
  }
  const [domain, command, ...rest] = argv;
  if (domain === undefined || command === undefined) {
    fail('gcb gh needs a command, for example: gcb gh pr view 12 --repo owner/name');
  }
  const actionName = `${domain}:${command}`;
  let action;
  try {
    action = getGhAction(actionName);
  } catch {
    fail(`unknown gh action ${JSON.stringify(actionName)}`);
  }

  const booleans = action.flags.filter((flag) => flag.type === 'boolean').map((flag) => flag.name);
  const args = parseArgs(rest, { booleans });
  const repo = args.value('repo') ?? fail('--repo is required');
  const host = args.value('host') ?? 'github.com';
  const socketPath = resolveSocketPath(args.value('socket'), process.env);
  if (socketPath === undefined) fail('no broker socket is configured');

  const allowed = new Set([
    ...action.flags.map((flag) => flag.name),
    'repo',
    'host',
    'socket',
  ]);
  for (const argument of rest) {
    const match = /^--([^=]+)/.exec(argument);
    if (match?.[1] !== undefined && !allowed.has(match[1])) {
      fail(`unknown option --${match[1]} for gcb gh ${domain} ${command}`);
    }
  }

  const values: Record<string, string | boolean | string[]> = {};
  for (const [index, positional] of action.positionals.entries()) {
    const value = args.positionals[index];
    if (value === undefined) {
      if (positional.required === true) fail(`gcb gh ${domain} ${command} needs ${positional.name}`);
      continue;
    }
    values[positional.name] = value;
  }
  if (args.positionals.length > action.positionals.length) {
    fail(`gcb gh ${domain} ${command} has too many positional arguments`);
  }
  for (const flag of action.flags) {
    if (flag.type === 'boolean') {
      if (args.has(flag.name)) values[flag.name] = true;
      continue;
    }
    const entries = args.values(flag.name);
    if (entries.length === 0) {
      if (flag.required === true) fail(`gcb gh ${domain} ${command} needs --${flag.name}`);
      continue;
    }
    if (flag.repeatable === true) values[flag.name] = entries;
    else values[flag.name] = entries[0] as string;
  }

  let response;
  try {
    response = await requestOverSocket(
      socketPath,
      { op: 'action', host, path: repo, ghAction: actionName, values: values as ActionValues },
      action.timeoutSeconds * 1000 + 5_000,
    );
  } catch (error) {
    fail((error as Error).message);
  }
  if (response.ok !== true) {
    fail(`refused [${response.code ?? 'unknown'}]: ${response.reason ?? 'no reason'}`);
  }
  if (response.stdout) process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  if (response.timedOut === true) fail(`the action timed out after ${action.timeoutSeconds}s`);
  return response.exitCode === 0 ? 0 : 1;
}
