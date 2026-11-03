/**
 * `doctor` — report the local configuration and last reload without touching GitHub.
 *
 * This is the observability half of live reload: the digest is what the file contains now, and the
 * audit's last `config` record says whether the running daemon accepted it or is still on the last
 * good snapshot.
 */
import { createHash } from 'node:crypto';
import net from 'node:net';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { parseDocument } from 'yaml';

import { loadConfigText, readConfigText, resolveConfigPath } from '../config.ts';
import { createLineReader, fail, parseArgs, say } from 'gcb-core';

export const DOCTOR_USAGE = `Usage: gcb doctor [options]

Report the configuration digest, the audit path and last reload, and the socket file.

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

interface LastConfig {
  readonly event?: ConfigEvent;
  readonly error?: Error;
}

/** Read the last config reload record, scanning backward a chunk at a time. */
function lastConfigEvent(path: string | null): LastConfig {
  if (path === null) return {};
  let fd: number;
  try {
    // O_NONBLOCK keeps a FIFO on this path from hanging the command; fstat below rejects it.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : { error: error as Error };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { error: new Error(`audit log is not a regular file: ${path}`) };
    }
    let position = stat.size;
    let carry = Buffer.alloc(0);
    while (position > 0) {
      const length = Math.min(CHUNK_BYTES, position);
      position -= length;
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, position);
      // Split on the newline byte before decoding: 0x0a cannot occur inside a UTF-8 sequence.
      const pieces = Buffer.concat([buffer, carry]).toString('latin1').split('\n');
      // The first piece is the tail of a record that starts in the previous (earlier) chunk.
      carry = position > 0 ? Buffer.from(pieces.shift() ?? '', 'latin1') : Buffer.alloc(0);
      for (let index = pieces.length - 1; index >= 0; index -= 1) {
        const line = Buffer.from(pieces[index] ?? '', 'latin1').toString('utf8').trim();
        if (!line) continue;
        try {
          const event = JSON.parse(line) as ConfigEvent & { event?: unknown };
          if (event.event === 'config') return { event };
        } catch {
          // A partially written line is expected after a crash; an earlier record still counts.
        }
      }
    }
    return {};
  } catch (error) {
    return { error: error as Error };
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

/**
 * Read one string key from raw YAML when the rest of the file is invalid.
 *
 * @param text - the raw configuration text.
 * @param key - the top-level key to read.
 * @returns the value, or null when absent/empty or an unquoted null/~.
 */
export function rawString(text: string, key: 'auditPath' | 'socketPath'): string | null {
  try {
    const parsed = parseDocument(text).toJS() as Record<string, unknown> | null;
    if (parsed !== null && Object.hasOwn(parsed, key)) {
      const value = parsed[key];
      if (typeof value === 'string') return value.trim() === '' ? null : value;
      if (value === null || value === undefined) return null;
    }
  } catch {
    // An unparseable file still gets the line-based fallback below.
  }
  const match = new RegExp(
    `^(?:"${key}"|'${key}'|${key}):[ \\t]*(?:"([^"]*)"|'([^']*)'|([^\\n]*?))(?:[ \\t]+#.*)?$`,
    'm',
  ).exec(text);
  if (match?.[1] !== undefined || match?.[2] !== undefined) {
    const quoted = (match[1] ?? match[2] ?? '').trim();
    return quoted === '' ? null : quoted;
  }
  const value = match?.[3]?.trim();
  return value === undefined || value === '' || value === 'null' || value === '~' ? null : value;
}

/** How long doctor waits for the daemon's ping answer. */
const PING_TIMEOUT_MS = 500;

/** Ask the running daemon which audit path it actually uses: undefined means no answer. */
function activeAuditPath(socketPath: string): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const socket = net.connect(socketPath);
    const finish = (answer: string | null | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    timer = setTimeout(() => finish(undefined), PING_TIMEOUT_MS);
    const reader = createLineReader({
      onLine: (line) => {
        try {
          const answer = JSON.parse(line) as { ok?: unknown; auditPath?: unknown };
          if (answer.ok === true && (answer.auditPath === null || typeof answer.auditPath === 'string')) {
            finish(answer.auditPath === '' ? null : answer.auditPath);
            return;
          }
        } catch {
          // Not a ping answer; fall back to the configured path.
        }
        finish(undefined);
      },
    });
    socket.on('data', reader);
    socket.once('connect', () => socket.write(JSON.stringify({ op: 'ping' }) + '\n'));
    socket.once('error', () => finish(undefined));
  });
}

/**
 * Run the `doctor` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code.
 */
export async function runDoctor(
  argv: readonly string[],
  write: (line: string) => void = say,
): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help'] });
  if (args.has('help') || args.has('h')) {
    write(DOCTOR_USAGE);
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
  const configured = config !== undefined ? config.auditPath : rawString(text, 'auditPath');
  const socketPath = config !== undefined ? config.socketPath : rawString(text, 'socketPath');
  const activePath = socketPath === null ? undefined : await activeAuditPath(socketPath);
  const auditPath = activePath === undefined ? configured : (activePath ?? configured);
  const lastResult = lastConfigEvent(auditPath);
  const last = lastResult.event;
  const reloadLabel =
    activePath === null && auditPath ? 'last reload (historical, from configured audit log)' : 'last reload';

  write(loadError === undefined ? `config: ${path} ok` : `config: ${path} invalid: ${loadError.message}`);
  write(`digest: ${digest}`);
  if (!auditPath) {
    write(`${reloadLabel}: (no auditPath configured)`);
  } else if (lastResult.error !== undefined) {
    write(`${reloadLabel}: (cannot read the audit log: ${lastResult.error.message})`);
  } else if (last === undefined) {
    write(`${reloadLabel}: (no config record in the audit log)`);
  } else {
    const matched =
      typeof last.digest === 'string' ? (last.digest === digest ? 'digest matches' : 'digest differs') : 'digest unknown';
    write(
      `${reloadLabel}: ${String(last.decision ?? 'unknown')} at ${String(last.ts ?? 'unknown')} (${matched})` +
        (typeof last.reason === 'string' ? ` — ${last.reason}` : ''),
    );
  }
  if (auditPath) {
    write(
      activePath === undefined
        ? `audit: ${auditPath} (configured; the running daemon may still use its startup path)`
        : activePath === null
          ? `audit: ${auditPath} (configured; the running daemon writes no audit log)`
          : `audit: ${auditPath} (active daemon path)`,
    );
  }
  if (config !== undefined) write(`socket: ${socketLine(config.socketPath, config.socketMode)}`);
  return loadError === undefined ? 0 : 1;
}
