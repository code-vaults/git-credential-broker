/**
 * `doctor` — report the local configuration and last reload without touching GitHub.
 *
 * This is the observability half of live reload: the digest is what the file contains now, and the
 * audit's last `config` record says whether the running daemon accepted it or is still on the last
 * good snapshot.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';

import { loadConfig, readConfigText, resolveConfigPath } from '../config.ts';
import { fail, parseArgs, say } from 'gcb-core';

export const DOCTOR_USAGE = `Usage: gcb doctor [options]

Report the configuration digest, the last reload result and the socket file.

  --config <path>  Config file (default: $GIT_BROKER_CONFIG, else ./broker.config.yml)
  -h, --help       Show this help
`;

/** One config audit record, as far as the report needs it. */
interface ConfigEvent {
  readonly decision?: unknown;
  readonly reason?: unknown;
  readonly ts?: unknown;
}

/** Read the last config reload record, ignoring an absent or unreadable audit log. */
function lastConfigEvent(path: string | null): ConfigEvent | undefined {
  if (path === null || !existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const event = JSON.parse(line) as ConfigEvent & { event?: unknown };
      if (event.event === 'config') return event;
    } catch {
      // A partially written last line is expected after a crash; an earlier record still counts.
    }
  }
  return undefined;
}

/**
 * Run the `doctor` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code.
 */
export function runDoctor(argv: readonly string[]): number {
  const args = parseArgs(argv, { booleans: ['help'] });
  if (args.has('help') || args.has('h')) {
    say(DOCTOR_USAGE);
    return 0;
  }
  for (const name of args.names) {
    if (name !== 'config' && name !== 'help' && name !== 'h') fail(`unknown option --${name}`);
  }
  const configValues = args.values('config');
  if (args.has('config') || configValues.length > 1) fail('--config may only be given once and needs a value');
  const configArg = configValues[0];
  if (configArg === '') fail('--config needs a value');

  const path = resolveConfigPath(configArg);
  let config;
  try {
    config = loadConfig(path);
  } catch (error) {
    fail((error as Error).message);
  }
  const digest = createHash('sha256').update(readConfigText(path)).digest('hex');
  const last = lastConfigEvent(config.auditPath);

  say(`config: ${path} ok`);
  say(`digest: ${digest}`);
  say(
    last === undefined
      ? 'last reload: (no config record in the audit log)'
      : `last reload: ${String(last.decision ?? 'unknown')} at ${String(last.ts ?? 'unknown')}` +
          (typeof last.reason === 'string' ? ` — ${last.reason}` : ''),
  );
  if (existsSync(config.socketPath)) {
    const mode = (statSync(config.socketPath).mode & 0o777).toString(8).padStart(3, '0');
    say(`socket: ${config.socketPath} present (mode ${mode})`);
  } else {
    say(`socket: ${config.socketPath} missing`);
  }
  return 0;
}
