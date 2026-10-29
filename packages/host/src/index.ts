/**
 * Host-side entry point: the broker daemon and administration commands.
 *
 * This is the only side that imports `yaml` (through config.ts) and holds the App key.
 */
import type { CommandBackend } from 'gcb-core';
import { assertProxyEnabled } from './proxy.ts';

export * from './gh.ts';

export const HOST_HELP = `gcb-host — host-side gcb broker and administration commands.

Usage: gcb <command> [options]

Commands
  app          Run the app broker (alias for daemon)
  host         Run the host operations opener (alias for host-opener)
  daemon       Run the broker (normally started by the service manager)
  init         Create or update the broker config, and install the key
  stage        Export a reviewed commit to where the broker will run
  compose      Print a Docker sidecar definition for the broker
  diagnose     Ask GitHub what the App can actually see
  authorize    Authorize this app once for person-authored pull requests
  host-opener  Watch for the container's pull-request requests and create them

Client commands such as setup/probe/logs/pr are in gcb-client.`;

async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'app':
    case 'daemon': {
      assertProxyEnabled();
      const { runDaemon } = await import('./daemon.ts');
      return runDaemon(rest);
    }
    case 'init':
      return (await import('./commands/init.ts')).runInit(rest);
    case 'stage':
      return (await import('./commands/stage.ts')).runStage(rest);
    case 'compose':
      return (await import('./commands/compose.ts')).runCompose(rest);
    case 'diagnose':
      return (await import('./commands/diagnose.ts')).runDiagnose(rest);
    case 'authorize':
      return (await import('./commands/authorize.ts')).runAuthorize(rest);
    case 'host':
    case 'host-opener':
      return (await import('./commands/host-opener.ts')).runHostOpener(rest);
    default:
      process.stderr.write(`gcb: unknown host command \`${command ?? ''}\`.\n`);
      return 1;
  }
}

export const hostBackend: CommandBackend = {
  role: 'host',
  commands: ['app', 'host', 'daemon', 'init', 'stage', 'compose', 'diagnose', 'authorize', 'host-opener'],
  help: HOST_HELP,
  run,
};
