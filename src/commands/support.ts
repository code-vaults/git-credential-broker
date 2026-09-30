/**
 * Shared helpers for the management commands.
 *
 * These exist so that the operations which used to live in shell scripts can run anywhere Node
 * runs, with no shell, and be unit-tested.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** One parsed command line. */
export interface Args {
  /** Every value given for a flag, in order. */
  values(name: string): string[];
  /** The first value given for a flag. */
  value(name: string): string | undefined;
  /** Whether a boolean flag was present. */
  has(name: string): boolean;
  /** Arguments that were not flags. */
  readonly positionals: readonly string[];
}

/** Options for {@link parseArgs}. */
export interface ParseArgsOptions {
  /** Flags that take no value. */
  readonly booleans?: readonly string[];
}

/**
 * Parse a command line.
 *
 * Accepts `--flag value`, `--flag=value`, repeated flags (collected in order) and `--` to end
 * flag parsing.
 *
 * @param argv - arguments after the command name.
 * @param options - flags that take no value.
 * @returns the parsed arguments.
 */
export function parseArgs(argv: readonly string[], options: ParseArgsOptions = {}): Args {
  const booleans = new Set(options.booleans ?? []);
  const collected = new Map<string, string[]>();
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    if (equals >= 0) {
      const name = argument.slice(2, equals);
      collected.set(name, [...(collected.get(name) ?? []), argument.slice(equals + 1)]);
      continue;
    }
    const name = argument.slice(2);
    if (booleans.has(name)) {
      flags.add(name);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      collected.set(name, [...(collected.get(name) ?? []), next]);
      index += 1;
    } else {
      flags.add(name);
    }
  }

  return {
    values: (name) => collected.get(name) ?? [],
    value: (name) => collected.get(name)?.[0],
    has: (name) => flags.has(name),
    positionals,
  };
}

/**
 * Split a repeatable list flag, so `--allow a/b --allow c/d` and `--allow a/b,c/d` both work.
 *
 * @param args - the parsed arguments.
 * @param name - the flag name.
 * @returns the entries, trimmed, with empty ones dropped.
 */
export function listFlag(args: Args, name: string): string[] {
  return args
    .values(name)
    .flatMap((value) => value.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Whether this process is running inside the agent container rather than on the host.
 *
 * The container mounts the workspace but has no `/volume1`, which is where the host keeps
 * everything this project needs to protect.
 *
 * @returns true when running inside the container.
 */
export function isInsideContainer(): boolean {
  return fs.existsSync('/home/app/Workspaces') && !fs.existsSync('/volume1');
}

/**
 * The container's mounts under the user's home, as seen from the host.
 *
 * A private key must never live under one of these.
 *
 * @param home - the home directory to resolve against.
 * @returns the absolute paths.
 */
export function mountedPaths(home: string = os.homedir()): string[] {
  return [path.join(home, 'Workspaces'), path.join(home, '.dsh'), path.join(home, '.dotfiles')];
}

/**
 * Whether a path is inside one of the container's mounts.
 *
 * @param target - the path to check.
 * @param home - the home directory to resolve against.
 * @returns the mount it is inside, or null.
 */
export function insideMountedPath(target: string, home: string = os.homedir()): string | null {
  const resolved = path.resolve(target);
  for (const mounted of mountedPaths(home)) {
    if (resolved === mounted || resolved.startsWith(`${mounted}${path.sep}`)) return mounted;
  }
  return null;
}

/**
 * Set one value in a git config file, creating it if needed.
 *
 * Shells out to `git config` rather than writing INI by hand, so escaping and existing content
 * are handled by git itself.
 *
 * @param file - the config file to write.
 * @param key - the key, e.g. `credential.useHttpPath` or `url.https://github.com/.insteadOf`.
 * @param value - the value.
 * @throws {Error} when git is missing or rejects the write.
 */
export function gitConfigSet(file: string, key: string, value: string): void {
  execFileSync('git', ['config', '--file', file, key, value], { stdio: ['ignore', 'ignore', 'pipe'] });
}

/**
 * Read a git config file as `key=value` lines.
 *
 * @param file - the config file to read.
 * @returns the lines, or an empty list when the file does not exist.
 */
export function gitConfigList(file: string): string[] {
  try {
    const output = execFileSync('git', ['config', '--file', file, '--list'], { encoding: 'utf8' });
    return output.split('\n').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/** Locations a system CA bundle may live at. */
const SYSTEM_CA_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/ssl/cert.pem',
  '/etc/pki/tls/certs/ca-bundle.crt',
];

/**
 * Find an existing system CA bundle.
 *
 * @returns the path, or null when the image ships none (see the README: git then cannot verify
 *   any TLS certificate, while Node still can, because Node bundles its own roots).
 */
export function findSystemCaBundle(): string | null {
  for (const candidate of SYSTEM_CA_BUNDLES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Write a CA bundle from Node's own trust store.
 *
 * The fallback for an image that installs git without `ca-certificates`. The dynamic import
 * keeps `node:tls` out of the credential-helper hot path.
 *
 * @param target - where to write the PEM bundle.
 * @returns the number of certificates written.
 */
export async function writeNodeCaBundle(target: string): Promise<number> {
  const { rootCertificates } = await import('node:tls');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${rootCertificates.join('\n')}\n`, { mode: 0o644 });
  return rootCertificates.length;
}

/**
 * Write a file with restrictive permissions, replacing any existing one.
 *
 * @param target - the path to write.
 * @param contents - the contents.
 * @param mode - the permission bits.
 */
export function writeSecretFile(target: string, contents: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, { mode });
  fs.chmodSync(target, mode);
}

/**
 * Print a message to stdout.
 *
 * @param message - the message.
 */
export function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

/**
 * Print a message to stderr.
 *
 * @param message - the message.
 */
export function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Exit with an error message.
 *
 * @param message - the message.
 * @returns never; the declared return type lets callers use it in expressions.
 */
export function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
