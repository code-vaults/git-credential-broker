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

import { canonicalPath } from '../paths.ts';

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
    // `-h` is advertised in every usage line and could never be true: an argument without two dashes went
    // straight to positionals. Normalising here keeps every command's existing checks working.
    const argument = argv[index]?.replace(/^-h$/, '--help').replace(/^-(?=[A-Za-z])/, '--');
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

/** The environment variable naming the directories the container shares with the host. */
export const MOUNTS_VAR = 'GIT_BROKER_MOUNTS';

/** Where the shared directories came from, when a caller supplies them instead of the environment. */
export interface MountSource {
  /** The raw value of {@link MOUNTS_VAR}. */
  readonly declared?: string;
  /** The contents of `/proc/self/mountinfo`. */
  readonly mountinfo?: string;
  /** `Mounts` arrays as the container runtime prints them; null when it could not be asked. */
  readonly inspect?: string | null;
  /** Whether this process is in the container, whose own mount table is the authority. */
  readonly container?: boolean;
}

/** The command that reports what running containers mount. */
const CONTAINER_CLI = 'docker';

/**
 * Decode one field of `/proc/self/mountinfo`.
 *
 * The kernel escapes space, tab, newline and backslash as octal, so a mount point containing a space
 * arrives as `\040` instead of splitting the line.
 *
 * @param value - the raw field.
 * @returns the decoded path.
 */
function decodeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_whole, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/**
 * `canonicalPath`, but a path that cannot be resolved is answered lexically.
 *
 * For a *candidate* in a list this is the safe direction. A host runs containers whose mounts this
 * user cannot read — measured: a Synology document-viewer mount answers EACCES — and one of those
 * must not stop the whole list being read. A candidate that is lexically under the home is still
 * treated as shared, which over-refuses rather than under-refuses. The strict form stays for the path
 * being guarded, where an answer that cannot be known is a refusal.
 *
 * @param target - the path to resolve.
 * @returns the real path, or the resolved path when it cannot be read.
 */
function canonicalOrResolved(target: string): string {
  try {
    return canonicalPath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The mount points at or under a home, read from a mount table.
 *
 * The container is the thing that knows what it mounts. A list of directory names in this file would
 * be a guess about someone else's home — `.dotfiles` is only ever what the user called it.
 *
 * @param mountinfo - the contents of `/proc/self/mountinfo`.
 * @param home - the home to measure against.
 * @returns the mount points, spelled as the table spells them.
 */
export function mountsUnderHome(mountinfo: string, home: string): string[] {
  const root = canonicalOrResolved(home);
  const found: string[] = [];
  for (const line of mountinfo.split('\n')) {
    const field = line.split(' ')[4];
    if (field === undefined) continue;
    const point = path.resolve(decodeMountField(field));
    const real = canonicalOrResolved(point);
    if (real === root || real.startsWith(`${root}${path.sep}`)) found.push(point);
  }
  return found;
}

/**
 * The host paths a container runtime bound from the user's home.
 *
 * `docker inspect --format '{{json .Mounts}}'` prints one array per container. Only bind mounts count:
 * a volume or a tmpfs is not a directory the user named. Every container is considered, not only the
 * agent's — any container that can rewrite a directory is a reason not to put the broker's code there
 * — so this is deliberately a superset.
 *
 * @param output - the runtime's output, one array per line.
 * @param home - the home to keep mounts under.
 * @returns the host paths, unique and canonical.
 */
export function boundPathsUnderHome(output: string, home: string): string[] {
  const root = canonicalOrResolved(home);
  const found = new Set<string>();
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    let mounts: unknown;
    try {
      mounts = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(mounts)) continue;
    for (const mount of mounts as Array<{ Type?: unknown; Source?: unknown }>) {
      if (mount.Type !== 'bind' || typeof mount.Source !== 'string') continue;
      const real = canonicalOrResolved(mount.Source);
      if (real === root || real.startsWith(`${root}${path.sep}`)) found.add(real);
    }
  }
  return [...found];
}

/**
 * Ask the container runtime which directories it has bound from the user's home.
 *
 * The host's own mount table cannot answer this: a bind mount exists only in the container's
 * namespace, so the runtime is asked instead.
 *
 * @param home - the home to keep mounts under.
 * @returns the paths, or undefined when the runtime is not there to ask.
 */
function detectedMounts(home: string): string[] | undefined {
  const run = (args: readonly string[]): string =>
    execFileSync(CONTAINER_CLI, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let ids: string;
  try {
    ids = run(['ps', '--quiet']);
  } catch {
    return undefined;
  }
  const running = ids.split('\n').map((id) => id.trim()).filter((id) => id !== '');
  if (running.length === 0) return [];
  try {
    return boundPathsUnderHome(run(['inspect', '--format', '{{json .Mounts}}', ...running]), home);
  } catch {
    return undefined;
  }
}

/**
 * The directories the container shares with the host.
 *
 * In order: `GIT_BROKER_MOUNTS`, which is how an operator overrides everything; the container's own
 * mount table, when this process is in the container; the container runtime, when it is not. Only
 * when none of the three can answer does this refuse — the guess it will not make is what would put
 * the broker's code, or the private key, in a directory a container can rewrite.
 *
 * @param home - the home whose mounts are wanted.
 * @param source - a declared value, mount table or runtime output, for a test.
 * @returns the shared directories.
 * @throws {Error} when nothing can answer.
 */
export function mountedPaths(home: string = os.homedir(), source: MountSource = {}): string[] {
  const declared = source.declared ?? process.env[MOUNTS_VAR];
  if (declared !== undefined && declared.trim() !== '') {
    return declared
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
  }

  let mounts: string[] | undefined;
  if (source.mountinfo !== undefined) {
    mounts = mountsUnderHome(source.mountinfo, home);
  } else if (source.inspect !== undefined) {
    mounts = source.inspect === null ? undefined : boundPathsUnderHome(source.inspect, home);
  } else if (source.container ?? fs.existsSync('/.dockerenv')) {
    try {
      mounts = mountsUnderHome(fs.readFileSync('/proc/self/mountinfo', 'utf8'), home);
    } catch {
      mounts = undefined;
    }
  } else {
    mounts = detectedMounts(home);
  }

  if (mounts === undefined) {
    throw new Error(
      `cannot tell which directories the container shares: set ${MOUNTS_VAR} to them, separated by ` +
        `"${path.delimiter}" (inside the container its mount table is read; on the host the container ` +
        'runtime is asked, and it did not answer)',
    );
  }
  return mounts;
}

/**
 * Whether a path is inside one of the directories the container shares with the host.
 *
 * Both sides are canonicalized before they are compared: `$HOME` on the host may be one name for a
 * directory the container sees under another (`/var/services/homes/u` and `/volume1/homes/u`), and a
 * lexical prefix check calls the same directory two different places.
 *
 * @param target - the path to check.
 * @param home - the home directory to resolve against.
 * @param mounts - the shared directories, when the caller already has them.
 * @returns the mount it is inside, or null.
 */
export function insideMountedPath(
  target: string,
  home: string = os.homedir(),
  mounts?: readonly string[],
): string | null {
  const resolved = canonicalPath(target);
  for (const mounted of mounts ?? mountedPaths(home)) {
    const real = canonicalPath(mounted);
    if (resolved === real || resolved.startsWith(`${real}${path.sep}`)) return mounted;
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
  // Not redundant. On an ACL-based share (Synology's `synoacl`) the mode passed to a create call
  // is advisory — the file comes out 0777 whatever you asked for — and only an explicit chmod
  // restricts it. Measured on the share this was written for.
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
