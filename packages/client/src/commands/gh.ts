/**
 * `gh` — run one catalogued GitHub action through the broker.
 *
 * The action catalog defines the command, flags, positionals and permissions. The client only
 * parses names and values; the broker rebuilds the canonical argv and runs gh with its own token.
 */
import { GH_ACTIONS, LOGIN, bodyFromArgs, buildGhArgv, getGhAction, parseArgs, say, fail, type ActionValues, type GhAction } from 'gcb-core';

import { requestOverSocket, resolveSocketPath } from '../helper.ts';
import { submitActionToHostBroker } from './host-submit.ts';
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
      : ` (one of ${action.exactlyOneOf
          .map((field) => (action.positionals.some((positional) => positional.name === field) ? field : `--${field}`))
          .join(', ')})`;
    const body = action.bodyRequiredWith === undefined
      ? ''
      : ` (--body required with ${action.bodyRequiredWith.map((flag) => `--${flag}`).join(', ')})`;
    const conflicts = action.conflicts === undefined
      ? ''
      : ` (not both ${action.conflicts.map(([left, right]) => `--${left}/--${right}`).join(', ')})`;
    return `  ${action.command.join(' ')}${positionals ? ` ${positionals}` : ''}${flags ? ` ${flags}` : ''}${modes}${body}${conflicts}`;
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
/** The argv scan shared by execution and the dispatcher's help decision. */
interface ActionScan {
  readonly rest: string[];
  readonly missingValue: string | undefined;
  readonly help: boolean;
  readonly allowed: ReadonlySet<string>;
  readonly asUser: boolean;
  readonly account: string | undefined;
  readonly identityError: string | undefined;
  readonly repoOption: boolean;
}

/** The flags that consume the following token, shared by the scan and identity extraction. */
function actionValueFlags(action: GhAction): ReadonlySet<string> {
  return new Set([
    ...action.flags.filter((flag) => flag.type !== 'boolean').map((flag) => flag.name),
    ...(action.flags.some((flag) => flag.name === 'body') ? ['body-file'] : []),
    'repo',
    'R',
    'host',
    'socket',
    'proxy',
  ]);
}

/**
 * Scan one action's raw argv the way runGh consumes it.
 *
 * @param action - the catalogued action.
 * @param rawRest - arguments after the domain and command.
 * @returns the normalized rest, a missing operand, and whether help was requested.
 */
function scanActionArgs(action: GhAction, rawRest: readonly string[]): ActionScan {
  const hasBody = action.flags.some((flag) => flag.name === 'body');
  const valueFlags = actionValueFlags(action);
  const allowed = new Set([
    ...action.flags.map((flag) => flag.name),
    ...(hasBody ? ['body-file'] : []),
    'repo',
    'R',
    'host',
    'socket',
    'proxy',
    'no-proxy',
  ]);
  const knownFlags = new Set([...allowed, 'help', 'as-user']);

  const rest: string[] = [];
  let missingValue: string | undefined;
  let help = false;
  let asUser = false;
  let account: string | undefined;
  let identityError: string | undefined;
  let repoOption = false;

  // A known value-taking flag consumes the next token only when that token is a value. A following
  // known flag is not taken as a value (so a missing value fails as missing), except a literal
  // --help/-h: a body that is exactly one of those is data, not a help request.
  for (let index = 0; index < rawRest.length; index += 1) {
    const raw = rawRest[index];
    // Match parseArgs: -h is help everywhere; any other single-dash letter is its long flag. A
    // single-dash operand belongs to a preceding value flag and was consumed before this point.
    const argument = raw?.replace(/^-h$/, '--help').replace(/^-(?=[A-Za-z])/, '--');
    if (argument === undefined) continue;
    if (argument === '--') {
      rest.push(...rawRest.slice(index));
      break;
    }
    if (argument === '--help') {
      help = true;
      rest.push(argument);
      continue;
    }
    if (argument === '--as-user') {
      if (asUser || account !== undefined) identityError ??= '--as-user may be given once';
      const next = rawRest[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        account = next;
        index += 1;
      } else {
        asUser = true;
      }
      continue;
    }
    if (argument.startsWith('--as-user=')) {
      if (asUser || account !== undefined) identityError ??= '--as-user may be given once';
      const value = argument.slice('--as-user='.length);
      if (value === '') asUser = true;
      else account = value;
      continue;
    }
    const name = argument.startsWith('--') && !argument.includes('=') ? argument.slice(2) : undefined;
    if (name === 'repo' || name === 'R') repoOption = true;
    if (/^--(?:repo|R)=/.test(argument)) repoOption = true;
    if (name === undefined || !valueFlags.has(name)) {
      rest.push(argument);
      continue;
    }
    const next = rawRest[index + 1];
    if (next === undefined) {
      missingValue ??= `${raw} needs a value`;
      rest.push(argument);
      continue;
    }
    if (next === '--help' || next === '-h') {
      if (name === 'body') {
        rest.push(`${argument}=${next}`);
        index += 1;
      } else {
        help = true;
        rest.push(argument);
      }
      continue;
    }
    if (next.startsWith('--')) {
      const nextName = next.slice(2).split('=')[0];
      if (nextName !== undefined && knownFlags.has(nextName)) {
        missingValue ??= `${raw} needs a value`;
      }
      // Leave both tokens alone: a known flag is a missing value, an unknown one must reach the
      // unknown-option check rather than becoming a value.
      rest.push(argument);
      continue;
    }
    rest.push(`${argument}=${next}`);
    index += 1;
  }
  return { rest, missingValue, help, allowed, asUser, account, identityError, repoOption };
}

/** Whether a catalogued action's argv carries either --as-user form, in option position. */
export function actionHasAsUser(actionName: string, rawRest: readonly string[]): boolean {
  const scan = scanActionArgs(getGhAction(actionName), rawRest);
  return scan.asUser || scan.account !== undefined;
}

/** Whether a catalogued action's argv asks for help, using the same scan. */
export function actionHelpRequested(actionName: string, rawRest: readonly string[]): boolean {
  try {
    return scanActionArgs(getGhAction(actionName), rawRest).help;
  } catch {
    return rawRest.includes('--help') || rawRest.includes('-h');
  }
}

export const GH_USAGE = `Usage: gcb gh <domain> <command> [options]

Run a catalogued GitHub action through the broker.
gcb pr <subcommand>, gcb run <subcommand> and gcb issue <subcommand> are shorthands for the same
actions.

Common
  -R, --repo <owner/name>  Repository the action belongs to (default: origin remote)
  --host <host>            Host as configured, e.g. github.com (default: github.com)
  --socket <path>          Broker socket (default: GIT_BROKER_SOCKET)
  --proxy <url>            Use this proxy for this action
  --body-file <path>       Read a body from a file, or '-' for stdin, for actions that accept --body
  --no-proxy               Reach GitHub directly for this action
  -h, --help               Show this help

Person route
  --as-user                App-broker person identity, for actions it can run as a person
  --as-user <login>        Host gh account; runs the catalogued action through gcb host

Commands, from the action catalog
${ACTION_LINES}`;

/**
 * Run the `gh` command.
 *
 * @param argv - arguments after `gh`.
 * @returns the process exit code: 0 success, 1 refusal, and the requested unreachable code
 *          (1 by default; `pr` passes 3 for runPr's contract).
 */
export async function runGh(
  argv: readonly string[],
  options: { readonly unreachableExitCode?: number; readonly identity?: 'app' | 'user' } = {},
): Promise<number> {
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

  const scan = scanActionArgs(action, rawRest);
  const { rest, missingValue, help, allowed, asUser, account, identityError, repoOption } = scan;
  if (help) {
    say(GH_USAGE);
    return 0;
  }
  if (missingValue !== undefined) fail(missingValue);
  if (identityError !== undefined) fail(identityError);
  const identity = options.identity ?? (asUser ? 'user' : 'app');
  if (account === undefined && identity === 'user' && action.appUser !== true) {
    fail(`${actionName} does not support --as-user`);
  }
  if (account !== undefined && !LOGIN.test(account)) {
    fail(`--as-user must be a GitHub login, got ${JSON.stringify(account)}`);
  }

  const booleans = action.flags.filter((flag) => flag.type === 'boolean').map((flag) => flag.name);
  const args = parseArgs(rest, { booleans: [...booleans, 'no-proxy'] });
  if (args.has('no-proxy') && args.value('proxy') !== undefined) fail('--proxy and --no-proxy are mutually exclusive');
  const proxy = args.has('no-proxy') ? null : args.value('proxy');
  const host = args.value('host') ?? 'github.com';
  let repo = args.value('repo') ?? args.value('R');
  if (repo === undefined && repoOption) {
    fail('--repo needs a value; refusing to fall back to the checkout');
  }
  if (repo === undefined) {
    const found = repoFromCheckout(process.cwd());
    if (found === undefined) fail('--repo is required when the checkout has no usable origin remote');
    if (found.host !== host.toLowerCase()) {
      fail(`the checkout's remote is on ${found.host}, but --host is ${host}; pass --repo or --host`);
    }
    repo = found.repo;
  }

  for (const argument of rest) {
    if (argument === '--') break;
    const match = /^--([^=]+)/.exec(argument);
    if (match?.[1] !== undefined && !allowed.has(match[1])) {
      fail(`unknown option --${match[1]} for gcb gh ${domain} ${command}`);
    }
  }

  const values: Record<string, string | boolean | string[]> = {};
  const bodyFile = args.value('body-file') !== undefined;
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
    if (flag.name === 'body') {
      if (bodyFile) continue;
      const inline = args.value('body');
      if (inline === undefined) {
        if (flag.required === true) fail(`gcb gh ${domain} ${command} needs --body`);
        continue;
      }
      values['body'] = inline;
      continue;
    }
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

  if (account !== undefined && args.value('socket') !== undefined) {
    fail('--socket is the app broker route; --as-user <login> uses the checkout channel');
  }

  if (bodyFile) {
    // Validate selection constraints before a '-' body waits for stdin; the actual body is built again below.
    try {
      buildGhArgv(actionName, { ...values, body: 'x' } as ActionValues, repo);
    } catch (error) {
      fail((error as Error).message);
    }
    const body = bodyFromArgs(args);
    if (body !== undefined) values['body'] = body;
  }
  try {
    buildGhArgv(actionName, values as ActionValues, repo);
  } catch (error) {
    fail((error as Error).message);
  }

  if (account !== undefined) {
    return submitActionToHostBroker({
      kind: 'action',
      action: actionName,
      repo,
      host,
      values,
      account,
      proxy,
      session: 'gh',
      pid: process.pid,
    });
  }

  const socketPath = resolveSocketPath(args.value('socket'), process.env);
  if (socketPath === undefined) fail('no broker socket is configured');

  let response;
  try {
    response = await requestOverSocket(
      socketPath,
      {
        op: 'action',
        host,
        path: repo,
        ghAction: actionName,
        values: values as ActionValues,
        ...(identity === 'user' ? { identity } : {}),
        proxy,
        session: 'gh',
        pid: process.pid,
      },
      action.timeoutSeconds * 1000 + 30_000,
    );
  } catch (error) {
    process.stderr.write(`unreachable: ${(error as Error).message}\n`);
    return options.unreachableExitCode ?? 1;
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
    const writeCaveat = Object.values(action.permissions).some((permission) => permission === 'write')
      ? '; a write may have completed before it was killed'
      : '';
    process.stderr.write(
      `warning: the action timed out after ${action.timeoutSeconds}s${writeCaveat}\n`,
    );
    return 1;
  }
  return response.exitCode === 0 ? 0 : 1;
}
