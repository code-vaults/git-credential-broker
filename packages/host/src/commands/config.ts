/**
 * `config` — inspect, edit and validate the broker configuration.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { inferMode, loadConfig, resolveConfigPath } from '../config.ts';
import { fail, parseArgs, say } from 'gcb-core';

export const CONFIG_USAGE = `Usage: gcb config check|edit [options]

Validate the broker configuration, or open it in $VISUAL/$EDITOR and validate the result.

  check            Validate the file without changing it
  edit             Open it, then validate the saved file
  --config <path>  Config file (default: $GIT_BROKER_CONFIG, else ./broker.config.yml)
  -h, --help       Show this help
`;

export function runConfig(argv: readonly string[]): number {
  const args = parseArgs(argv, { booleans: ['help'] });
  if (args.has('help') || args.has('h')) {
    say(CONFIG_USAGE);
    return 0;
  }
  const configValues = args.values('config');
  if (args.has('config') || configValues.length > 1) fail('--config may only be given once and needs a value');
  const configArg = configValues[0];
  if (configArg === '') fail('--config needs a value');
  for (const name of args.names) {
    if (name !== 'config' && name !== 'help' && name !== 'h') fail(`unknown option --${name}`);
  }
  const command = args.positionals[0];
  if (command !== 'check' && command !== 'edit') {
    fail('usage: gcb config check|edit [--config <path>]');
  }
  if (args.positionals.length !== 1) fail(`usage: gcb config ${command} [--config <path>]`);

  const path = resolveConfigPath(configArg);
  if (command === 'edit') {
    if (!existsSync(path)) fail(`cannot edit missing config ${path}`);
    const editor = process.env['VISUAL'] ?? process.env['EDITOR'];
    if (editor === undefined || editor.trim() === '') fail('config edit needs $VISUAL or $EDITOR');
    const result = spawnSync(editor, [path], { stdio: 'inherit' });
    if (result.error !== undefined) fail(`cannot run editor ${JSON.stringify(editor)}: ${result.error.message}`);
    if (result.status !== 0) fail(`editor exited with status ${String(result.status)}`);
  }

  try {
    const config = loadConfig(path);
    const hosts = Object.keys(config.hosts);
    say(`ok: ${path} (${inferMode(config)})`);
    say(`hosts: ${hosts.join(', ')}`);
    return 0;
  } catch (error) {
    fail((error as Error).message);
  }
}
