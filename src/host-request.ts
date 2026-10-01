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
} from 'node:fs';
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
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

/** One request to open a pull request. */
export interface HostOpenRequest {
  /** `owner/name`, when the caller knows it, so the opener need not infer it. */
  readonly repo?: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
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
    const candidate = join(current, '.git');
    if (existsSync(candidate)) {
      if (statSync(candidate).isDirectory()) return candidate;
      // A worktree or submodule records its real git directory in a file.
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(candidate, 'utf8'));
      const pointed = match?.[1]?.trim();
      return pointed ? resolve(current, pointed) : undefined;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
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
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.result.json') && name !== OPENER_FILE)
    .map((name) => name.slice(0, -'.json'.length))
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
export function removeRequest(dir: string, id: string): void {
  rmSync(join(dir, `${id}.json`), { force: true });
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
  if (!existsSync(file)) return undefined;
  try {
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
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temp, file);
}
