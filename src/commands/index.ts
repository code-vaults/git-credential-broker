/**
 * The management CLI.
 *
 * The command git invokes as a credential helper is the same command a human uses to set the
 * broker up: `get`/`store`/`erase` are the git protocol, everything else is a subcommand. That
 * keeps one name to remember and one thing to install.
 *
 * Subcommands are imported lazily so the credential-helper path — which git runs on every
 * request — stays as small as possible.
 */
import { packageVersion } from '../version.ts';
import { say } from './support.ts';

/** Help text. */
export const HELP = `git-credential-broker — short-lived, single-repository git credentials from a host-side broker.

Usage: git-credential-broker <command> [options]

Commands
  setup      Configure this environment's git to use the broker (run inside the container)
  init       Create or update the broker config, and install the key (run on the host)
  stage      Export the broker from a reviewed commit to where it will run (host, outside mounts)
  compose    Print a Docker sidecar definition for the broker
  probe      Ask the broker what it would do for a repository, without pushing
  logs       Read a workflow job's log through the broker (the token stays in the broker)
  diagnose   Ask GitHub what the App can actually see (installations, permissions, repositories)

Options
  -h, --help     Show this help
  -v, --version  Show the version

As a git credential helper
  git config --global credential.helper broker
  git config --global credential.useHttpPath true
  git-credential-broker get|store|erase    # what git calls; store and erase are no-ops

Environment
  GIT_BROKER_SOCKET       Broker socket path
  GIT_BROKER_REQUIRE=1    Fail closed instead of behaving as if not installed when unconfigured
  GIT_BROKER_SOCKET_FILE  Where to read the socket path from when no variable is set

Run \`git-credential-broker <command> --help\` for the options of one command.`;

/** The subcommands, in the order help lists them. */
export const COMMANDS = ['setup', 'init', 'stage', 'compose', 'probe', 'logs', 'diagnose'] as const;

/**
 * Dispatch a command line.
 *
 * @param argv - arguments after the script name.
 * @returns the process exit code.
 */
export async function runCli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined) {
    say(HELP);
    return 1;
  }
  if (command === 'help' || command === '--help' || command === '-h') {
    say(HELP);
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    say(packageVersion());
    return 0;
  }

  switch (command) {
    case 'setup':
      return (await import('./setup.ts')).runSetup(rest);
    case 'init':
      return (await import('./init.ts')).runInit(rest);
    case 'stage':
      return (await import('./stage.ts')).runStage(rest);
    case 'compose':
      return (await import('./compose.ts')).runCompose(rest);
    case 'probe':
      return (await import('./probe.ts')).runProbe(rest);
    case 'logs':
      return (await import('./logs.ts')).runLogs(rest);
    case 'diagnose':
      return (await import('./diagnose.ts')).runDiagnose(rest);
    default:
      process.stderr.write(`unknown command: ${command}\n\n`);
      say(HELP);
      return 1;
  }
}
