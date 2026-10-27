/**
 * `gh` — run one catalogued GitHub action through the broker.
 *
 * The action catalog defines the command, flags, positionals and permissions. The client only
 * parses names and values; the broker rebuilds the canonical argv and runs gh with its own token.
 */
import { GH_ACTIONS, getGhAction, parseArgs, say, fail, type ActionValues } from 'gcb-cli';

import { requestOverSocket, resolveSocketPath } from '../helper.ts';
import { remoteRepo } from './remotes.ts';

const ACTION_LINES = Object.values(GH_ACTIONS)
  .map((action) => {
    const positionals = action.positionals
      .map((positional) => (positional.required === true ? `<${positional.name}>` : `[${positional.name}]`))
      .join(' ');
    const flags = action.flags
      .map((flag) => {
        const spelling = `--${flag.name}${flag.type === 'boolean' ? '' : ` <${flag.type}>`}`;
        return flag.required === true ? spelling : `[${spelling}]`;
      })
      .join(' ');
    const modes = action.exactlyOneOf === undefined
      ? ''
      : ` (one of ${action.exactlyOneOf.map((flag) => `--${flag}`).join(', ')})`;
    const body = action.bodyRequiredWith === undefined
      ? ''
      : ` (--body required with ${action.bodyRequiredWith.map((flag) => `--${flag}`).join(', ')})`;
    return `  ${action.command.join(' ')}${positionals ? ` ${positionals}` : ''}${flags ? ` ${flags}` : ''}${modes}${body}`;
  })
  .join('\n');

/**
 * Read owner/repo from the checkout's `origin` remote.
 *
 * The URL parsing lives in `remotes.ts`, beside `--head origin:branch`, so the two cannot disagree
 * about what a remote points at.
 *
 * @param cwd - the checkout to ask.
 * @returns the normalized repository, or undefined when no remote names one.
 */
function repoFromCheckout(cwd: string): { repo: string; host: string } | undefined {
  const found = remoteRepo('origin', cwd);
  return found === undefined ? undefined : { repo: `${found.owner}/${found.repo}`, host: found.host };
}

/** Usage text for `gh`. */
export const GH_USAGE = `Usage: gcb gh <domain> <command> [options]

Run a catalogued GitHub action through the broker.
gcb pr <subcommand> and gcb run <subcommand> are shorthands for the same actions.

Common
  -R, --repo <owner/name>  Repository the action belongs to (default: origin remote)
  --host <host>            Host as configured, e.g. github.com (default: github.com)
  --socket <path>          Broker socket (default: GIT_BROKER_SOCKET)
  -h, --help               Show this help

Commands, from the action catalog
${ACTION_LINES}`;

/**
 * Run the `gh` command.
 *
 * @param argv - arguments after `gh`.
 * @returns the process exit code: 0 success, 1 refusal.
 */
export async function runGh(argv: readonly string[]): Promise<number> {
  if (argv.length === 0) {
    say(GH_USAGE);
    return 1;
  }
  const [domain, command, ...rawRest] = argv;
  if (domain === '--help' || domain === '-h' || command === '--help' || command === '-h') {
    say(GH_USAGE);
    return 0;
  }
  if (domain === undefined || command === undefined) {
    // A caller with a domain and no command (`gcb run`, `gcb gh pr`) gets the catalog rather than one
    // example: the answer is every action, and the example would only be right for one of them.
    say(GH_USAGE);
    return 1;
  }
  const actionName = `${domain}:${command}`;
  let action;
  try {
    action = getGhAction(actionName);
  } catch {
    if (rawRest.includes('--help') || rawRest.includes('-h')) {
      say(GH_USAGE);
      return 0;
    }
    fail(`unknown gh action ${JSON.stringify(actionName)}`);
  }

  // A known value-taking flag consumes the next token only when that token is a value. A following
  // flag is left alone (so a missing value fails as missing), except a literal --help/-h: a body that
  // is exactly one of those is data, not a help request. The parser then sees --body=--help.
  const valueFlags = new Set(action.flags.filter((flag) => flag.type !== 'boolean').map((flag) => flag.name));
  const rest: string[] = [];
  for (let index = 0; index < rawRest.length; index += 1) {
    const argument = rawRest[index];
    const name = argument?.startsWith('--') && !argument.includes('=') ? argument.slice(2) : undefined;
    const next = rawRest[index + 1];
    const nextIsFlag = next !== undefined && /^--?[A-Za-z]/.test(next);
    const literalHelp = next === '--help' || next === '-h';
    if (name !== undefined && valueFlags.has(name) && next !== undefined && (!nextIsFlag || literalHelp)) {
      rest.push(`${argument}=${next}`);
      index += 1;
    } else if (argument !== undefined) {
      rest.push(argument);
    }
  }

  // `help` is declared a boolean so it is a help request wherever it sits: a value flag's next token
  // was already merged above, so `--body --help` reaches the parser as data.
  const booleans = [
    ...action.flags.filter((flag) => flag.type === 'boolean').map((flag) => flag.name),
    'help',
  ];
  const args = parseArgs(rest, { booleans });
  if (args.has('help')) {
    say(GH_USAGE);
    return 0;
  }
  const host = args.value('host') ?? 'github.com';
  let repo = args.value('repo') ?? args.value('R');
  if (repo === undefined) {
    const found = repoFromCheckout(process.cwd());
    if (found === undefined) fail('--repo is required when the checkout has no usable origin remote');
    if (found.host !== host.toLowerCase()) {
      fail(`the checkout's remote is on ${found.host}, but --host is ${host}; pass --repo or --host`);
    }
    repo = found.repo;
  }
  const socketPath = resolveSocketPath(args.value('socket'), process.env);
  if (socketPath === undefined) fail('no broker socket is configured');

  const allowed = new Set([
    ...action.flags.map((flag) => flag.name),
    'repo',
    'R',
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
      { op: 'action', host, path: repo, ghAction: actionName, values: values as ActionValues, session: 'gh', pid: process.pid },
      action.timeoutSeconds * 1000 + 30_000,
    );
  } catch (error) {
    fail((error as Error).message);
  }
  if (response.ok !== true) {
    if (response.warning) process.stderr.write(`warning: ${response.warning}\n`);
    fail(`refused [${response.code ?? 'unknown'}]: ${response.reason ?? 'no reason'}`);
  }
  if (response.stdout) process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  if (response.warning) process.stderr.write(`warning: ${response.warning}\n`);
  if (response.truncated === true) {
    process.stderr.write('warning: the action output was truncated at the broker\x27s limit\n');
  }
  if (response.timedOut === true) {
    process.stderr.write(
      `warning: the action timed out after ${action.timeoutSeconds}s; a write may have completed before it was killed\n`,
    );
    return 1;
  }
  return response.exitCode === 0 ? 0 : 1;
}
