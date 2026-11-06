/**
 * `config` — inspect, edit and validate the broker configuration.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, chownSync, existsSync, linkSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { parseDocument, isMap, isScalar, isSeq } from 'yaml';

import { inferMode, loadConfig, loadConfigText, readConfigText, resolveConfigPath } from '../config.ts';
import { parseAllowEntry } from '../policy.ts';
import { fail, parseArgs, say } from 'gcb-core';

export const CONFIG_USAGE = `Usage: gcb config check|edit|allow add|remove [options]

Validate or edit the broker configuration, or change one allowlist entry.

  check                       Validate the file without changing it
  edit                        Open it in $VISUAL/$EDITOR and validate the saved file
  allow add <host> <repo>     Append one exact owner/name entry (no glob, URL, wildcard or .git)
  allow remove <host> <repo>  Remove one exact owner/name entry (no glob, URL, wildcard or .git)
  --config <path>             Config file (default: $GIT_BROKER_CONFIG, else ./broker.config.yml)
  -h, --help                  Show this help
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
  if (command !== 'check' && command !== 'edit' && command !== 'allow') {
    fail('usage: gcb config check|edit|allow add|remove [--config <path>]');
  }
  if (command !== 'allow' && args.positionals.length !== 1) {
    fail(`usage: gcb config ${command} [--config <path>]`);
  }

  const path = resolveConfigPath(configArg);
  if (command === 'edit') {
    if (!existsSync(path)) fail(`cannot edit missing config ${path}`);
    const editor = process.env['VISUAL'] ?? process.env['EDITOR'];
    if (editor === undefined || editor.trim() === '') fail('config edit needs $VISUAL or $EDITOR');
    // Edit in place: this path needs write access to the file; some editors also need its directory.
    // `$VISUAL`/`$EDITOR` is a shell command in git's own semantics; `$@` keeps the path intact.
    const result = spawnSync('/bin/sh', ['-c', `${editor} "$@"`, editor, path], { stdio: 'inherit' });
    if (result.error !== undefined) {
      fail(`cannot run editor ${JSON.stringify(editor)}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const how = result.status === null ? `signal ${String(result.signal)}` : `status ${String(result.status)}`;
      fail(`editor exited with ${how}`);
    }
  }

  if (command === 'allow') {
    try {
      changeAllow(path, args.positionals);
    } catch (error) {
      fail((error as Error).message);
    }
    return 0;
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

/** How long an update waits for another config update to finish. */
const LOCK_WAIT_MS = 5_000;

/**
 * Sleep without yielding the event loop; this command is synchronous by design.
 *
 * @param ms - milliseconds to wait.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether a pid is still alive.
 *
 * @param pid - the pid to probe.
 * @returns true when the process exists.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user; ESRCH is the only dead answer.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Describe a lock-creation failure without exposing an internal temp name.
 *
 * @param path - the config path the user named.
 * @param directory - its directory.
 * @param error - the underlying filesystem error.
 * @returns the error to throw.
 */
function lockError(path: string, directory: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException).code ?? 'error';
  const detail =
    code === 'EACCES' || code === 'EROFS'
      ? `${directory} must be writable`
      : `${code}: ${(error as Error).message}`;
  return new Error(`cannot lock ${path}: ${detail}`);
}

/**
 * Resolve the real file a config path names, keeping a missing-file message useful.
 *
 * @param path - the configured path, which may be a symlink.
 * @returns the target path.
 */
function configTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`cannot read config ${path}: ${(error as Error).message}`);
    }
    throw error;
  }
}

/**
 * Serialize one read/update/replace sequence on a config file.
 *
 * @param path - the configuration path.
 * @param fn - the update to run while holding the lock.
 * @returns whatever the update returns.
 */
function withConfigLock<T>(path: string, fn: (target: string) => T): T {
  const target = configTarget(path);
  const lock = `${target}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    // Write the pid to a private temp name, then hard-link it into place. link(2) is atomic and
    // the lock is never visible empty, unlike open-then-write.
    const temporary = `${lock}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      try {
        writeFileSync(temporary, String(process.pid), { mode: 0o644, flag: 'wx' });
      } catch (error) {
        throw lockError(path, dirname(target), error);
      }
      linkSync(temporary, lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw lockError(path, dirname(target), error);
      }
      let pid: number | undefined;
      try {
        pid = Number(readFileSync(lock, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const usablePid = Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff;
      if (!usablePid) {
        let age = 0;
        try {
          age = Date.now() - statSync(lock).mtimeMs;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        // Only a lock from an older writer can be empty now; give it a moment, then fail closed.
        if (age <= 1_000 && Date.now() < deadline) {
          sleepSync(50);
          continue;
        }
        throw new Error(`stale lock ${lock}; remove it if no gcb command is running`);
      }
      if (pidAlive(pid)) {
        if (Date.now() >= deadline) {
          throw new Error(`another gcb command is updating ${path}; retry after it finishes`);
        }
        sleepSync(50);
        continue;
      }
      // Recovering a stale lock by unlink/rename races the holder's release and a new acquirer,
      // and the loser can delete a lock the winner just created. Fail closed instead; removing the
      // file is a deliberate operator action once no gcb command is running.
      throw new Error(`stale lock ${lock}; remove it if no gcb command is running`);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  try {
    return fn(target);
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Apply one allowlist add or remove, validate the result, then replace the file atomically.
 *
 * @param path - the configuration file.
 * @param positionals - `allow`, `add|remove`, host, `owner/name`.
 */
function changeAllow(path: string, positionals: readonly string[]): void {
  if (positionals.length !== 4) {
    throw new Error('usage: gcb config allow add|remove <host> <owner/name> [--config <path>]');
  }
  const action = positionals[1]!;
  const host = positionals[2]!;
  const repository = positionals[3]!.trim();
  if (action !== 'add' && action !== 'remove') {
    throw new Error('usage: gcb config allow add|remove <host> <owner/name> [--config <path>]');
  }
  const parsed = parseAllowEntry(repository);
  if (
    parsed === null ||
    parsed.owner === '*' ||
    parsed.repo === '*' ||
    repository.toLowerCase().endsWith('.git')
  ) {
    throw new Error(
      `repository must be one exact owner/name without a wildcard or .git, got ${JSON.stringify(repository)}`,
    );
  }

  withConfigLock(path, (target) => {
    const before = readConfigText(target);
    if (before.includes('\r\n') && /(^|[^\r])\n/u.test(before)) {
      throw new Error(`config ${path} has mixed line endings; normalize it to LF or CRLF first`);
    }
    const document = parseDocument(before, { schema: 'core', uniqueKeys: true, prettyErrors: true });
    if (document.errors.length > 0) {
      throw new Error(
        `config ${path} is not valid YAML: ${document.errors.map((error) => error.message).join('; ')}`,
      );
    }
    const hostNode = document.getIn(['hosts', host], true);
    if (!isMap(hostNode)) throw new Error(`no host ${JSON.stringify(host)} in ${path}`);
    const allowNode = hostNode.get('allow', true);
    if (allowNode !== undefined && !isSeq(allowNode)) {
      throw new Error(`hosts.${host}.allow must be a list`);
    }
    const entries = isSeq(allowNode)
      ? allowNode.items.map((item) => (isScalar(item) ? String(item.value) : undefined))
      : [];
    const normalized = entries.map((entry) => entry?.trim().toLowerCase());
    const wanted = repository.toLowerCase();
    const index = normalized.findIndex((entry) => entry === wanted);

    if (action === 'add') {
      if (index !== -1) throw new Error(`${repository} is already in ${host}.allow`);
      if (isSeq(allowNode)) {
        allowNode.add(repository);
      } else {
        hostNode.set('allow', document.createNode([repository]));
      }
    } else {
      if (index === -1 || !isSeq(allowNode)) throw new Error(`${repository} is not in ${host}.allow`);
      const kept = allowNode.items.filter((_item, position) => normalized[position] !== wanted);
      if (kept.length === 0) {
        throw new Error(`refusing to remove: this would leave the allowlist empty for ${host}`);
      }
      allowNode.items = kept;
    }

    const serialized = document.toString();
    const newline = before.includes('\r\n') ? '\r\n' : '\n';
    const after =
      newline === '\n' ? serialized : serialized.replace(/\r?\n/gu, '\n').replace(/\n/gu, '\r\n');
    loadConfigText(after, path);
    const original = statSync(target);
    const mode = original.mode & 0o777;
    const temporary = `${target}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      // wx is O_EXCL: a pre-created symlink at this name fails rather than chooses the target.
      writeFileSync(temporary, after, { flag: 'wx', mode });
      // Write an exact mode: the create mode is filtered by umask on some shares.
      chmodSync(temporary, mode);
      try {
        chownSync(temporary, original.uid, original.gid);
      } catch {
        // Ownership is best-effort metadata; the mode still matches the original.
      }
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
    say(
      `allow ${action} ${host} ${repository}: written; entry=${repository} reload=unconfirmed signal=unavailable (run gcb doctor; a restart is needed for socketPath, socketMode or auditPath)`,
    );
  });
}
