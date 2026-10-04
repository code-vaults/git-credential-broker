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
 * Whether this process is running inside a container rather than on the host.
 *
 * A credential must not be written anywhere a container can read it, and the broker must not run
 * inside the agent container. Docker and Podman each leave a marker; nothing here names a directory,
 * because no directory is this tool's to assume.
 *
 * Those markers are also this function's known gap, and it does double duty. A container that leaves
 * neither — plain containerd, a Kubernetes pod — reads as a host: the "run this on the host" refusal
 * in `init` and `authorize` does not fire, and `mountedPaths` looks for a runtime instead of reading
 * the mount table it is standing on. `setup`, which is in the container by definition, says so itself
 * and reads the table. The refusal cases still fail closed afterwards, when no runtime can be asked,
 * but they fail with a message about the runtime rather than about the container.
 *
 * @returns true when running inside a container.
 */
export function isInsideContainer(): boolean {
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

/** Where the shared directories came from, when a caller supplies them instead of detecting them. */
export interface MountSource {
  /** The contents of `/proc/self/mountinfo`. */
  readonly mountinfo?: string;
  /** `Mounts` arrays as the container runtime prints them; null when it could not be asked. */
  readonly inspect?: string | null;
  /** Whether this process is in the container, whose own mount table is the authority. */
  readonly container?: boolean;
  /** How to run a container runtime command, so a test need not have one installed. */
  readonly exec?: (cli: string, args: readonly string[]) => string;
}

/**
 * The commands that can report what running containers mount.
 *
 * Docker, Podman and nerdctl share the `ps`/`inspect` interface used here, so one code path covers all
 * three. Plain containerd has no equivalent — `ctr` speaks a different language, in a namespace it
 * chooses — so a host that offers only that is refused rather than guessed at.
 */
const CONTAINER_CLIS = ['docker', 'podman', 'nerdctl'] as const;

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
 * Whether a path is the root of its filesystem.
 *
 * Every mount table lists the container's own root filesystem, and that root is the image's, not a
 * directory the host handed over. Counting it as shared would put every path "inside a mount" and
 * refuse `setup` its own config; a *bind* of the host root arrives through the runtime instead, where
 * it does count.
 *
 * @param target - the path to test.
 * @returns true when it is a filesystem root.
 */
function filesystemRoot(target: string): boolean {
  const resolved = path.resolve(target);
  return resolved === path.parse(resolved).root;
}

/**
 * Whether one canonical directory contains another.
 *
 * The root is special in its spelling and nothing else: `'/'.startsWith('/' + '/')` is false, so the
 * ordinary prefix test says the host root contains nothing at all.
 *
 * @param parent - the directory that would contain.
 * @param child - the path it would contain.
 * @returns true when parent holds child.
 */
function contains(parent: string, child: string): boolean {
  if (child === parent) return true;
  return filesystemRoot(parent) ? child.startsWith(parent) : child.startsWith(`${parent}${path.sep}`);
}

/**
 * Whether one canonical directory contains the other.
 *
 * Both directions matter. A mount *under* the home is shared, and so is a mount that *contains* the
 * home: a container that binds `/srv` while the home is `/srv/u` can rewrite everything in the home,
 * so dropping that mount for sitting above the home is the same blind spot in the other direction.
 *
 * @param a - one canonical path.
 * @param b - the other canonical path.
 * @returns true when either contains the other.
 */
function overlaps(a: string, b: string): boolean {
  return contains(a, b) || contains(b, a);
}

/**
 * The mount points that overlap a home, read from a mount table.
 *
 * The container is the thing that knows what it mounts. A list of directory names in this file would
 * be a guess about a home this code has never seen.
 *
 * @param mountinfo - the contents of `/proc/self/mountinfo`.
 * @param home - the home to measure against.
 * @returns the mount points, spelled as the table spells them.
 */
export function mountsTouchingHome(mountinfo: string, home: string): string[] {
  const root = canonicalOrResolved(home);
  const found: string[] = [];
  for (const line of mountinfo.split('\n')) {
    const field = line.split(' ')[4];
    if (field === undefined) continue;
    const point = path.resolve(decodeMountField(field));
    // The container's own root filesystem is in every mount table, and it is not a shared directory.
    if (filesystemRoot(point)) continue;
    if (overlaps(canonicalOrResolved(point), root)) found.push(point);
  }
  return found;
}

/**
 * The host paths a container runtime bound that overlap the user's home.
 *
 * `docker inspect --format '{{json .Mounts}}'` prints one array per container. Only bind mounts count:
 * a volume or a tmpfs is not a directory the user named. Every container is considered, not only the
 * agent's — any container that can rewrite a directory is a reason not to put the broker's code there
 * — so this is deliberately a superset.
 *
 * @param output - the runtime's output, one array per line.
 * @param home - the home to compare against.
 * @returns the host paths, unique and canonical.
 */
export function boundPathsTouchingHome(output: string, home: string): string[] {
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
      if (overlaps(real, root)) found.add(real);
    }
  }
  return [...found];
}

/**
 * What a runtime had to say: it is not installed (skip it), it is there and could not be asked (a
 * blind spot, so the whole check refuses), or it answered.
 */
type RuntimeQuery =
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ok'; readonly containers: number; readonly mounts: string[] };

/** Run a container runtime command; a failure means that runtime could not be asked. */
function runtimeExec(cli: string, args: readonly string[]): string {
  return execFileSync(cli, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * Whether a failed spawn means the command is not installed, rather than installed and failing.
 *
 * The difference decides whether the guard can proceed at all. A host that has only docker must not be
 * refused because podman is missing; a host whose docker daemon is unreachable must be, because its
 * containers are precisely the ones nothing else can see.
 *
 * @param error - the error a spawn threw.
 * @returns true when the command was not found at all.
 */
function notInstalled(error: unknown): boolean {
  return (error as { code?: unknown } | null | undefined)?.code === 'ENOENT';
}

/**
 * One runtime's answer.
 *
 * `--all`, not only the running containers: a stopped container's bind mounts are still configured and
 * it can be started again at any time. This is most likely to run while the agent container is down —
 * `init` on a fresh host, or a boot script — which is exactly when a running-only list is blind.
 *
 * @param cli - the command to run.
 * @param home - the home to compare against.
 * @param exec - how to run it.
 * @returns what this runtime had to say.
 */
function mountsFromRuntime(
  cli: string,
  home: string,
  exec: (cli: string, args: readonly string[]) => string,
): RuntimeQuery {
  let ids: string;
  try {
    ids = exec(cli, ['ps', '--all', '--quiet']);
  } catch (error) {
    return notInstalled(error) ? { kind: 'absent' } : { kind: 'failed' };
  }
  const known = ids.split('\n').map((id) => id.trim()).filter((id) => id !== '');
  if (known.length === 0) return { kind: 'ok', containers: 0, mounts: [] };
  try {
    const listed = exec(cli, ['inspect', '--format', '{{json .Mounts}}', ...known]);
    return { kind: 'ok', containers: known.length, mounts: boundPathsTouchingHome(listed, home) };
  } catch {
    // It listed containers a moment ago, so it is installed. Failing now is a blind spot, not absence.
    return { kind: 'failed' };
  }
}

/**
 * Ask every container runtime on this host which directories it has bound near the user's home.
 *
 * The host's own mount table cannot answer this: a bind mount exists only in the container's
 * namespace, so the runtimes are asked instead. Their answers are unioned, because one host can run
 * more than one of them and a container under either is still a container that can rewrite the code.
 *
 * Two states are not answers, and both make the caller refuse. A runtime that knows of no container at
 * all is one — the agent container may simply be stopped, its mounts still configured. A runtime that
 * is installed but cannot be queried is the other: its containers are invisible, and another runtime's
 * list cannot cover for them.
 *
 * @param home - the home to compare against.
 * @param exec - how to run a runtime.
 * @returns the paths, or undefined when they cannot be known.
 */
function detectedMounts(home: string, exec: (cli: string, args: readonly string[]) => string): string[] | undefined {
  const found = new Set<string>();
  let containers = 0;
  for (const cli of CONTAINER_CLIS) {
    const answer = mountsFromRuntime(cli, home, exec);
    if (answer.kind === 'absent') continue;
    if (answer.kind === 'failed') return undefined;
    containers += answer.containers;
    for (const mount of answer.mounts) found.add(mount);
  }
  return containers === 0 ? undefined : [...found];
}

/**
 * The directories the container shares with the host.
 *
 * The container's own mount table answers when this process is in the container; the container runtime
 * answers when it is not. Only when neither can does this refuse — the guess it will not make is what
 * would put the broker's code, or the private key, in a directory a container can rewrite.
 *
 * @param home - the home whose mounts are wanted.
 * @param source - a mount table or runtime output, for a test.
 * @returns the shared directories.
 * @throws {Error} when nothing can answer.
 */
export function mountedPaths(home: string = os.homedir(), source: MountSource = {}): string[] {
  const container = source.container ?? isInsideContainer();
  let mounts: string[] | undefined;
  if (source.mountinfo !== undefined) {
    mounts = mountsTouchingHome(source.mountinfo, home);
  } else if (source.inspect !== undefined) {
    mounts = source.inspect === null ? undefined : boundPathsTouchingHome(source.inspect, home);
  } else if (container) {
    try {
      mounts = mountsTouchingHome(fs.readFileSync('/proc/self/mountinfo', 'utf8'), home);
    } catch {
      mounts = undefined;
    }
  } else {
    mounts = detectedMounts(home, source.exec ?? runtimeExec);
  }

  if (mounts === undefined) {
    throw new Error(
      'cannot tell which directories the container shares: ' +
        (container
          ? 'its own mount table could not be read'
          : 'none of docker, podman or nerdctl could be asked, or none knows of a container') +
        '; refusing rather than guessing',
    );
  }
  return mounts;
}

/**
 * Whether a path is inside one of the directories the container shares with the host.
 *
 * Both sides are canonicalized before they are compared: the host may spell a directory one way and
 * the container another (a symlinked home, a bind mount reached two ways), and a lexical prefix check
 * calls the same directory two different places.
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
    // The mount side takes the tolerant form: discovery may have kept a mount that answers EACCES in
    // its lexical spelling, and one unreadable mount elsewhere must not fail a check about this target.
    // `contains`, not a prefix test, or a container binding the host root would be discovered and then
    // never matched — `'/x'.startsWith('//')` is false.
    if (contains(canonicalOrResolved(mounted), resolved)) return mounted;
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
