/**
 * Container-side entry point: the git credential helper and the socket-backed commands.
 *
 * The host commands are not imported here; installing `gcb-client` never pulls `yaml`.
 */
import { CLIENT_COMMANDS, GH_ACTIONS } from 'gcb-core';
import type { CommandBackend } from 'gcb-core';
import type { Primary } from './primary.ts';

export { runHelper } from './helper.ts';

/**
 * The catalogued subcommands of one domain, for the help text.
 *
 * The dispatch below reads the same table, so this cannot list a subcommand that does not run and a
 * new action shows up in the help without a second edit.
 *
 * @param domain - the command before the colon, e.g. `pr`.
 * @returns the subcommands, joined for one usage line.
 */
function cataloguedSubcommands(domain: string): string {
  return Object.values(GH_ACTIONS)
    .filter((action) => action.command[0] === domain)
    .map((action) => action.command[1])
    .join('|');
}

export const CLIENT_HELP = `gcb-client — container-side git credential helper and broker client.

Usage: gcb <command> [options]

Commands
  setup      Configure this environment's git to use the broker
  probe      Ask the broker what it would do for a repository, without pushing
  logs       Read a workflow job's log through the broker
  pr         Use the broker's pull-request lifecycle; these run as gh actions:
             ${cataloguedSubcommands('pr')}
  run        Run a workflow run action: ${cataloguedSubcommands('run')}
  issue      Run an issue action: ${cataloguedSubcommands('issue')}
  repo       Create a fork as a person: fork
  gh         Run a catalogued GitHub action through the broker

As a git credential helper
  gcb get|store|erase    # what git calls; store and erase are no-ops

Environment
  GIT_BROKER_SOCKET       Broker socket path
  GIT_BROKER_REQUIRE=1    Fail closed instead of behaving as if not installed when unconfigured
  GIT_BROKER_SOCKET_FILE  Where to read the socket path from when no variable is set
  GCB_PROXY               Per-push broker proxy: a URL, or empty for direct
  GCB_PRIMARY             CLI that runs catalogued actions (default: gh)

Host commands such as init/stage/compose/diagnose are in gcb-host.`;

const isAsUser = (argument: string): boolean =>
  argument === '--as-user' || argument === '-as-user' || argument.startsWith('--as-user=') || argument.startsWith('-as-user=');

const hasAsUser = (argv: readonly string[]): boolean => argv.some(isAsUser);

/** Split at `--`; options before it, operands after it unchanged. */
function splitTerminator(argv: readonly string[]): { options: readonly string[]; operands: readonly string[] } {
  const terminator = argv.indexOf('--');
  return terminator === -1
    ? { options: argv, operands: [] }
    : { options: argv.slice(0, terminator), operands: argv.slice(terminator) };
}

/** Ask the selected action's own scan, rather than a second interpretation of its argv. */
async function actionAsksHelp(domain: string, sub: string | undefined, argv: readonly string[]): Promise<boolean> {
  if (sub === undefined || sub.startsWith('-')) {
    return argv.includes('--help') || argv.includes('-h');
  }
  return (await import('./commands/gh.ts')).actionHelpRequested(`${domain}:${sub}`, argv);
}

export async function runClient(argv: readonly string[], primary?: Primary): Promise<number> {
  const choose = async (): Promise<Primary> => primary ?? (await import('./primary.ts')).primaryFromEnv();
  const [command, ...rest] = argv;
  switch (command) {
    case 'setup':
      return (await import('./commands/setup.ts')).runSetup(rest);
    case 'probe':
      return (await import('./commands/probe.ts')).runProbe(rest);
    case 'logs':
      return (await import('./commands/logs.ts')).runLogs(rest);
    case 'pr': {
      // The catalog is the one source for an action, so the shorthand asks it rather than keeping a
      // second list: a subcommand the catalog does not have stays with the flag-only lifecycle.
      // Bare `pr` asks the catalog too, where `run` needs no branch: the flag-only path would only
      // tell it that --repo is required.
      if (rest.length === 0) return (await choose()).run(['pr']);
      const sub = rest[0];
      if (sub === 'review' && rest.some((argument) => argument === '--id' || argument.startsWith('--id='))) {
        return (await import('./commands/pr.ts')).runPr(rest.slice(1));
      }
      if (sub === 'create' && hasAsUser(splitTerminator(rest).options)) {
        // `pr create` is the catalogued action, but `--as-user` is the flag-only lifecycle's flag.
        // Accept the obvious spelling instead of making the caller discover that `create` must go.
        return (await import('./commands/pr.ts')).runPr(rest.slice(1));
      }
      if (sub !== undefined && Object.hasOwn(GH_ACTIONS, `pr:${sub}`)) {
        if (await actionAsksHelp('pr', sub, rest)) {
          return (await import('./commands/gh.ts')).runGh(['pr', ...rest], { unreachableExitCode: 3 });
        }
        return (await choose()).run(['pr', ...rest], { unreachableExitCode: 3 });
      }
      return (await import('./commands/pr.ts')).runPr(rest);
    }
    case 'run':
      if (await actionAsksHelp('run', rest[0], rest)) {
        return (await import('./commands/gh.ts')).runGh(['run', ...rest]);
      }
      return (await choose()).run(['run', ...rest]);
    case 'issue':
      if (await actionAsksHelp('issue', rest[0], rest)) {
        return (await import('./commands/gh.ts')).runGh(['issue', ...rest]);
      }
      return (await choose()).run(['issue', ...rest]);
    case 'repo':
      return (await import('./commands/repo.ts')).runRepo(rest);
    case 'gh':
      return (await import('./commands/gh.ts')).runGh(rest);
    default:
      process.stderr.write(`gcb: unknown client command \`${command ?? ''}\`.\n`);
      return 1;
  }
}

export const clientBackend: CommandBackend = {
  role: 'client',
  commands: CLIENT_COMMANDS,
  help: CLIENT_HELP,
  run: runClient,
};
