/**
 * `doctor` — report the local configuration and last reload without touching GitHub.
 *
 * This is the observability half of live reload: the digest is what the file contains now, and the
 * audit's last `config` record says whether the running daemon accepted it or is still on the last
 * good snapshot.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

import { loadConfigText, readConfigText, resolveConfigPath } from '../config.ts';
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
  readonly digest?: unknown;
}

const CHUNK_BYTES = 64 * 1024;

/** Read the last config reload record, scanning backward a chunk at a time. */
function lastConfigEvent(path: string | null): ConfigEvent | undefined {
  if (path === null || !existsSync(path)) return undefined;
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return undefined;
  }
  try {
    let position = fstatSync(fd).size;
    let carry = '';
    while (position > 0) {
      const length = Math.min(CHUNK_BYTES, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, position);
      const lines = (buffer.toString('utf8') + carry).split('\n');
      // The first element is the tail of a record that starts in the previous (earlier) chunk.
      carry = position > 0 ? (lines.shift() ?? '') : '';
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim();
        if (!line) continue;
        try {
          const event = JSON.parse(line) as ConfigEvent & { event?: unknown };
          if (event.event === 'config') return event;
        } catch {
          // A partially written line is expected after a crash; an earlier record still counts.
        }
      }
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Describe the configured socket path without calling something the broker refuses healthy. */
function socketLine(path: string, expectedMode: number): string {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? `missing: ${path}`
      : `cannot inspect ${path}: ${(error as Error).message}`;
  }
  if (stat.isSymbolicLink()) return `symlink (broker refuses): ${path}`;
  if (!stat.isSocket()) {
    const kind = stat.isFile() ? 'regular file' : stat.isDirectory() ? 'directory' : 'not a socket';
    return `${kind} (broker refuses): ${path}`;
  }
  const mode = (stat.mode & 0o777).toString(8).padStart(3, '0');
  const expected = (expectedMode & 0o777).toString(8).padStart(3, '0');
  return `present (mode ${mode}${mode === expected ? '' : `, expected ${expected}`}): ${path}`;
}

/** Pull auditPath out of raw YAML even when the rest of the file is invalid. */
function rawAuditPath(text: string): string | null {
  const match = /^auditPath:\s*(?:"([^"]*)"|'([^']*)'|([^\n]*?)(?:[ \t]+#.*)?)$/m.exec(text);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
  return value === undefined || value === '' ? null : value;
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
  if (args.positionals.length > 0) fail(`unexpected argument ${JSON.stringify(args.positionals[0])}`);
  for (const name of args.names) {
    if (name !== 'config' && name !== 'help' && name !== 'h') fail(`unknown option --${name}`);
  }
  const configValues = args.values('config');
  if (args.has('config') || configValues.length > 1) fail('--config may only be given once and needs a value');
  const configArg = configValues[0];
  if (configArg === '') fail('--config needs a value');

  const path = resolveConfigPath(configArg);
  let config: ReturnType<typeof loadConfigText> | undefined;
  let text: string;
  let loadError: Error | undefined;
  try {
    text = readConfigText(path);
  } catch (error) {
    fail((error as Error).message);
  }
  try {
    // One read: the digest must describe the bytes that were validated, even if the host replaces
    // the file between the load and the report.
    config = loadConfigText(text, path);
  } catch (error) {
    loadError = error as Error;
  }
  const digest = createHash('sha256').update(text).digest('hex');
  const auditPath = config !== undefined ? config.auditPath : rawAuditPath(text);
  const last = lastConfigEvent(auditPath);

  say(loadError === undefined ? `config: ${path} ok` : `config: ${path} invalid: ${loadError.message}`);
  say(`digest: ${digest}`);
  if (auditPath === null || auditPath === "") {
    say('last reload: (no auditPath configured)');
  } else if (last === undefined) {
    say('last reload: (no config record in the audit log)');
  } else {
    const matched =
      typeof last.digest === 'string' ? (last.digest === digest ? 'digest matches' : 'digest differs') : 'digest unknown';
    say(
      `last reload: ${String(last.decision ?? 'unknown')} at ${String(last.ts ?? 'unknown')} (${matched})` +
        (typeof last.reason === 'string' ? ` — ${last.reason}` : ''),
    );
  }
  if (config !== undefined) say(`socket: ${socketLine(config.socketPath, config.socketMode)}`);
  return loadError === undefined ? 0 : 1;
}
