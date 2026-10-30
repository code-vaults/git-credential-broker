/**
 * `config` — inspect and validate the broker configuration.
 */
import { inferMode, loadConfig, resolveConfigPath } from '../config.ts';
import { fail, parseArgs, say } from 'gcb-core';

export const CONFIG_USAGE = `Usage: gcb config check [options]

Validate the broker configuration without starting the service.

  --config <path>  Config file (default: $GIT_BROKER_CONFIG, else ./broker.config.yml)
  -h, --help       Show this help
`;

export async function runConfig(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help'] });
  if (args.has('help') || args.has('h')) {
    say(CONFIG_USAGE);
    return 0;
  }
  if (args.positionals[0] !== 'check' || args.positionals.length !== 1) {
    fail('usage: gcb config check [--config <path>]');
  }
  const path = resolveConfigPath(args.value('config'));
  try {
    const config = loadConfig(path);
    const hosts = Object.keys(config.hosts);
    say(`ok: ${path} (${inferMode(config)})`);
    say(`hosts: ${hosts.length === 0 ? '(none)' : hosts.join(', ')}`);
    return 0;
  } catch (error) {
    fail((error as Error).message);
  }
}
