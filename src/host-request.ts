/**
 * The channel between this side and a host-side opener.
 *
 * Opening a pull request is the one operation that has to happen as a person rather than as the app:
 * a pull request authored by the app's bot is something automated reviewers are entitled to skip, and
 * the app cannot pose as a person — that would defeat the point of it holding only a scoped token.
 *
 * So the container leaves a *request* in the shared checkout, a host-side process the operator started
 * fulfils it with their own credentials, and the answer comes back the same way. The directory sits
 * under the git directory, which both sides of the mount see and git never tracks, so a pending
 * request dirties no working tree and the two processes need no protocol beyond a file appearing and
 * another appearing back.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The directory under the git directory that carries requests and answers. */
export const CHANNEL_PATH = 'git-credential-broker/pr-requests';

/** The file naming the running opener. */
export const OPENER_FILE = 'opener.json';

/** How long a caller waits for an answer. */
export const ANSWER_TIMEOUT_MS = 120_000;

/** The same bounds the broker applies, so a request is refused here rather than there. */
export const MAX_TITLE_CHARS = 256;
export const MAX_BODY_CHARS = 65_536;

/** Branch names that are passed on, matching the broker's rule: plausible, and never `..`. */
// An optional `owner:` prefix, which is how GitHub spells "this branch lives in a fork". Exported because
// the broker validates the same two fields on the socket, and a second copy of this rule is how the two
// ends came to disagree about what a branch may look like.
export const BRANCH = /^([A-Za-z0-9][A-Za-z0-9._-]{0,38}:)?[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

/** One request to open a pull request. */
export interface HostOpenRequest {
  /** `owner/name`, when the caller knows it, so the opener need not infer it. */
  readonly repo?: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
  /** Open it as a draft. */
  readonly draft?: boolean;
  readonly session?: string;
  readonly pid?: number;
}

/** What the opener answered. */
export interface HostOpenResult {
  readonly number?: number;
  readonly url?: string;
  readonly error?: string;
}

/** The running opener, as it advertises itself. */
export interface OpenerInfo {
  readonly pid?: number;
  readonly command?: string;
  readonly startedAt?: string;
}

/**
 * Find the git directory at or above a path.
 *
 * @param from - where to start looking.
 * @returns the git directory, or `undefined` when there is none.
 */
export function findGitDir(from: string): string | undefined {
  let current = resolve(from);
  for (;;) {
    const found = gitDirAt(current);
    if (found !== undefined) return found;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The git directory directly inside a directory, if there is one.
 *
 * @param dir - the directory to look in, and not above.
 * @returns the git directory, or `undefined`.
 */
function gitDirAt(dir: string): string | undefined {
  const candidate = join(dir, '.git');
  if (!existsSync(candidate)) return undefined;
  if (statSync(candidate).isDirectory()) {
    // Followed by statSync on purpose, and then checked: a symlink to any directory was a way to publish
    // a container-chosen path as a channel. A git directory has a HEAD; anything else is not one.
    return existsSync(join(candidate, 'HEAD')) ? candidate : undefined;
  }
  // A worktree or submodule records its real git directory in a file.
  let text: string;
  try {
    // Written by the container, so it can be unreadable, or gone between the check above and here.
    text = readFileSync(candidate, 'utf8');
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  const pointed = match?.[1]?.trim();
  if (pointed === undefined) return undefined;
  const resolved = resolve(dir, pointed);
  // A .git file is a pointer written by whoever has the checkout, which is the container. Treat it as a
  // candidate rather than an answer: it has to look like a git directory, and nothing is created from it.
  try {
    if (!statSync(resolved).isDirectory()) return undefined;
    if (!existsSync(join(resolved, 'HEAD'))) return undefined;
  } catch {
    return undefined;
  }
  return resolved;
}

/** Directory names that never hold a checkout worth serving. */
const SKIP = new Set(['.git', 'node_modules', '@eaDir', '#recycle', '$RECYCLE.BIN', 'Library', '.Trash', '.cache']);

/**
 * Find the checkouts under a root.
 *
 * The opener is meant to be started once for a machine, so it is given roots rather than one
 * repository: every checkout below them is served, including ones created later. Dotted
 * directories are *not* skipped — a dotfiles repository is one, and it is a checkout like any
 * other. A directory holding a checkout is not descended into, which keeps the walk cheap.
 *
 * @param root - where to start.
 * @param maxDepth - how many levels below the root to look.
 * @returns each checkout, with the channel directory that belongs to it.
 */
export function discoverCheckouts(root: string, maxDepth = 4): { repo: string; dir: string }[] {
  const found: { repo: string; dir: string }[] = [];
  const walk = (current: string, depth: number): void => {
    const gitDir = gitDirAt(current);
    if (gitDir !== undefined) {
      found.push({ repo: current, dir: channelDir(gitDir) });
      return;
    }
    if (depth >= maxDepth) return;
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP.has(entry.name)) continue;
      walk(join(current, entry.name), depth + 1);
    }
  };
  walk(resolve(root), 0);
  return found;
}

/**
 * The channel directory for a git directory.
 *
 * @param gitDir - the repository's git directory.
 * @returns the directory requests and answers live in.
 */
export function channelDir(gitDir: string): string {
  return join(gitDir, CHANNEL_PATH);
}

/**
 * Read the opener's marker.
 *
 * @param dir - the channel directory.
 * @returns what the opener said about itself, or `undefined` when none is running.
 */
export function readOpener(dir: string): OpenerInfo | undefined {
  const file = join(dir, OPENER_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as OpenerInfo) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write the opener's marker.
 *
 * @param dir - the channel directory.
 * @param info - what to advertise.
 */
export function writeOpener(dir: string, info: OpenerInfo): void {
  writeJsonAtomic(join(dir, OPENER_FILE), info);
}

/**
 * Remove the opener's marker.
 *
 * @param dir - the channel directory.
 */
export function clearOpener(dir: string): void {
  rmSync(join(dir, OPENER_FILE), { force: true });
}

/**
 * Name a new request, unique enough for one directory.
 *
 * @param now - the clock, for tests.
 * @returns the identifier.
 */
export function newId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '');
  const noise = Math.floor(Math.random() * 0x1_0000)
    .toString(16)
    .padStart(4, '0');
  return `${stamp}-${noise}`;
}

/**
 * What is wrong with a request, if anything.
 *
 * @param request - the request to check.
 * @returns one message per problem, empty when there is none.
 */
export function requestProblems(request: HostOpenRequest): string[] {
  const problems: string[] = [];
  if (!BRANCH.test(request.head) || request.head.includes('..')) {
    problems.push('the head branch name is not usable');
  }
  if (!BRANCH.test(request.base) || request.base.includes('..')) {
    problems.push('the base branch name is not usable');
  }
  if (request.head === request.base) problems.push('the head and the base are the same branch');
  if (request.title.trim() === '' || request.title.length > MAX_TITLE_CHARS) {
    problems.push(`the title must be 1 to ${MAX_TITLE_CHARS} characters`);
  }
  if (request.body.length > MAX_BODY_CHARS) {
    problems.push(`the body must be at most ${MAX_BODY_CHARS} characters`);
  }
  return problems;
}

/**
 * Write a request.
 *
 * @param dir - the channel directory.
 * @param request - what to ask for.
 * @returns the identifier the answer will carry.
 * @throws {Error} when the request is not one the opener would accept.
 */
export function writeRequest(dir: string, request: HostOpenRequest): string {
  const problems = requestProblems(request);
  if (problems.length > 0) throw new Error(problems.join('; '));
  mkdirSync(dir, { recursive: true });
  const id = newId();
  writeJsonAtomic(join(dir, `${id}.json`), { v: 1, id, createdAt: new Date().toISOString(), ...request });
  return id;
}

/**
 * Read a request.
 *
 * @param dir - the channel directory.
 * @param id - the identifier.
 * @returns the request, or `undefined` when it is gone or unreadable.
 */
export function readRequest(dir: string, id: string): HostOpenRequest | undefined {
  const parsed = readJson(join(dir, `${id}.json`)) as Partial<HostOpenRequest> | undefined;
  if (!parsed) return undefined;
  if (typeof parsed.head !== 'string' || typeof parsed.base !== 'string' || typeof parsed.title !== 'string') {
    return undefined;
  }
  return {
    repo: typeof parsed.repo === 'string' ? parsed.repo : undefined,
    head: parsed.head,
    base: parsed.base,
    title: parsed.title,
    body: typeof parsed.body === 'string' ? parsed.body : '',
    draft: parsed.draft === true,
    session: parsed.session,
    pid: parsed.pid,
  };
}

/**
 * Every pending request, oldest first.
 *
 * @param dir - the channel directory.
 * @returns the identifiers.
 */
export function listRequests(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    // Only regular files. The container writes this directory, so anything else here — a directory, a FIFO,
    // a symlink to a host file — is aimed at the opener rather than written by it.
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.json') &&
        !entry.name.endsWith('.result.json') &&
        entry.name !== OPENER_FILE,
    )
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .sort();
}

/**
 * Read an answer.
 *
 * @param dir - the channel directory.
 * @param id - the identifier of the request it answers.
 * @returns the answer, or `undefined` while the opener has not replied.
 */
export function readResult(dir: string, id: string): HostOpenResult | undefined {
  const parsed = readJson(join(dir, `${id}.result.json`)) as Partial<HostOpenResult> | undefined;
  return parsed ?? undefined;
}

/**
 * Write an answer.
 *
 * @param dir - the channel directory.
 * @param id - the identifier of the request it answers.
 * @param result - what happened.
 */
export function writeResult(dir: string, id: string, result: HostOpenResult): void {
  writeJsonAtomic(join(dir, `${id}.result.json`), { v: 1, id, ...result });
}

/**
 * Remove a request, once it has been answered.
 *
 * @param dir - the channel directory.
 * @param id - the identifier.
 */
/**
 * Take a request, so that nobody else can act on it.
 *
 * Acting first and removing it afterwards is not enough: opening a pull request is not idempotent, and the
 * window between the two is as long as the program takes. The rename is atomic, so exactly one caller wins,
 * and a claimed name is not a request id, so a sweep in another process does not see it again.
 *
 * @param dir - the channel directory.
 * @param id - the request id.
 * @returns the request, or undefined when it was gone or is already claimed.
 */
export function claimRequest(dir: string, id: string): HostOpenRequest | undefined {
  const claimed = join(dir, `${id}.json.working`);
  try {
    renameSync(join(dir, `${id}.json`), claimed);
  } catch {
    return undefined;
  }
  const request = readJson(claimed) as HostOpenRequest | undefined;
  if (request === undefined) {
    rmSync(claimed, { force: true, recursive: true });
    return undefined;
  }
  return request;
}

export function removeRequest(dir: string, id: string): void {
  // Recursive: a directory here is not a request, and it must not be able to make this throw. The claimed
  // copy is not touched: it belongs to whoever claimed it, and deleting it here would take a request out
  rmSync(join(dir, `${id}.json`), { force: true, recursive: true });
}

/**
 * Remove an answer, once it has been read.
 *
 * @param dir - the channel directory.
 * @param id - the identifier.
 */
export function removeResult(dir: string, id: string): void {
  rmSync(join(dir, `${id}.result.json`), { force: true });
}

/**
 * Wait for an answer to a request.
 *
 * @param dir - the channel directory.
 * @param id - the identifier.
 * @param timeoutMs - how long to wait.
 * @param pollMs - how often to look.
 * @returns the answer, or `undefined` if the wait ran out.
 */
export async function waitForResult(
  dir: string,
  id: string,
  timeoutMs: number = ANSWER_TIMEOUT_MS,
  pollMs = 500,
): Promise<HostOpenResult | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = readResult(dir, id);
    if (result) return result;
    if (Date.now() >= deadline) return undefined;
    await new Promise((done) => setTimeout(done, pollMs));
  }
}

/**
 * Read JSON, tolerating anything that is not there.
 *
 * @param file - the path.
 * @returns the parsed value, or `undefined`.
 */
function readJson(file: string): unknown {
  try {
    const stat = lstatSync(file);
    // lstat on purpose: a symlink is not a request, and following one would read a file outside the
    // channel. A FIFO would block here forever, with no error and no log line to explain it.
    if (!stat.isFile() || stat.size > MAX_BODY_CHARS * 4) return undefined;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Write JSON so that a reader never sees half of it.
 *
 * @param file - the path.
 * @param value - the value to write.
 */
function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const temp = `${file}.${process.pid}.tmp`;
  const exclusive = (path: string) => writeFileSync(path, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    // wx is the whole protection: the name is predictable and the container can write this directory, so
    // without O_EXCL a symlink here would choose which host file the opener — running as a person — writes.
    exclusive(temp);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    rmSync(temp, { force: true, recursive: true });
    exclusive(temp);
  }
  // A directory where the destination belongs would make the rename throw and take the opener with it.
  try {
    if (!lstatSync(file).isFile()) rmSync(file, { force: true, recursive: true });
  } catch {
    // Not there at all, which is the usual case.
  }
  renameSync(temp, file);
}
