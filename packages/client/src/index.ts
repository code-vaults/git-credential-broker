/**
 * Container-side entry point: the git credential helper and the socket-backed commands.
 *
 * The host commands are not imported here; installing `gcb-client` never pulls `yaml`.
 */
import { GH_ACTIONS } from 'gcb-cli';
import type { CommandBackend } from 'gcb-cli';

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
  gh         Run a catalogued GitHub action through the broker

As a git credential helper
  gcb get|store|erase    # what git calls; store and erase are no-ops

Environment
  GIT_BROKER_SOCKET       Broker socket path
  GIT_BROKER_REQUIRE=1    Fail closed instead of behaving as if not installed when unconfigured
  GIT_BROKER_SOCKET_FILE  Where to read the socket path from when no variable is set
  GCB_PROXY               Per-push broker proxy: a URL, or empty for direct

Host commands such as init/stage/compose/diagnose are in gcb-host.`;

async function run(argv: readonly string[]): Promise<number> {
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
      if (rest.length === 0) return (await import('./commands/gh.ts')).runGh(['pr']);
      const sub = rest[0];
      if (sub !== undefined && Object.hasOwn(GH_ACTIONS, `pr:${sub}`)) {
        return (await import('./commands/gh.ts')).runGh(['pr', ...rest], { unreachableExitCode: 3 });
      }
      return (await import('./commands/pr.ts')).runPr(rest);
    }
    case 'run':
      return (await import('./commands/gh.ts')).runGh(['run', ...rest]);
    case 'gh':
      return (await import('./commands/gh.ts')).runGh(rest);
    default:
      process.stderr.write(`gcb: unknown client command \`${command ?? ''}\`.\n`);
      return 1;
  }
}

export const clientBackend: CommandBackend = {
  role: 'client',
  commands: ['setup', 'probe', 'logs', 'pr', 'run', 'gh'],
  help: CLIENT_HELP,
  run,
};
