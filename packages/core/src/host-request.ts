/**
 * The channel between this side and a host-side host broker.
 *
 * Creating a pull request or issue is the operation that has to happen as a person rather than as the
 * app: content authored by the app's bot is something automated reviewers are entitled to skip, and
 * the app cannot pose as a person — that would defeat the point of it holding only a scoped token.
 *
 * So the container leaves a *request* in the shared checkout, a host-side process the operator started
 * fulfils it with the credentials of the account it names, and the answer comes back the same way. The directory sits
 * under the git directory, which both sides of the mount see and git never tracks, so a pending
 * request dirties no working tree and the two processes need no protocol beyond a file appearing and
 * another appearing back.
 */
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  futimesSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { realpathSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { randomUUID } from 'node:crypto';

import { canonicalPath } from './paths.ts';

/** The directory under the git directory that carries requests and answers. */
export const CHANNEL_PATH = 'gcb/host-broker';

/** The file naming the running host broker. */
export const HOST_BROKER_FILE = 'host-broker.json';

/** How long a caller waits for an answer. */
// Longer than the host broker's own program timeout (CREATE_TIMEOUT_MS, 120s) plus the interval at which it
// notices a request, because the caller is waiting for an answer to work that has not started yet.
export const ANSWER_TIMEOUT_MS = 180_000;

/** The same bounds the broker applies, so a request is refused here rather than there. */
export const MAX_TITLE_CHARS = 256;
export const MAX_BODY_CHARS = 65_536;

/** A GitHub login, used to pick the host's gh config directory for `--as-user`. */
export const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** Branch names that are passed on, matching the broker's rule: plausible, and never `..`. */
// An optional `owner:` prefix, which is how GitHub spells "this branch lives in a fork". Exported because
// the broker validates the same two fields on the socket, and a second copy of this rule is how the two
// ends came to disagree about what a branch may look like.
export const BRANCH = /^([A-Za-z0-9][A-Za-z0-9._-]{0,38}:)?[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;

/** `owner/name`, as a fork request names its source. */
export const REPOSITORY = /^(?!\.+(?:\/|$))[A-Za-z0-9_.-]+\/(?!\.+$)[A-Za-z0-9_.-]+$/;

/** A host key, optionally with a port; never a URL, slash or newline. */
export const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;

interface HostRequestFields {
  /** `owner/name` for an explicit-repository request; absent means the checkout decides. */
  readonly repo?: string;
  readonly title: string;
  readonly body: string;
  /** Egress for the host broker's gh call: absent = its environment, null = direct, string = proxy URL. */
  readonly proxy?: string | null;
  /** GitHub login whose `~/.config/gh-<login>` the host broker uses; absent = its own gh config. */
  readonly account?: string;
  readonly session?: string;
  readonly pid?: number;
}

/** One request to open a pull request. */
export interface HostOpenRequest extends HostRequestFields {
  readonly kind?: 'pull-request';
  readonly head: string;
  readonly base: string;
  /** Open it as a draft. */
  readonly draft?: boolean;
}

/** One request to reply inside a pull request review thread. */
export interface HostReplyRequest {
  readonly kind: 'reply';
  readonly repo: string;
  readonly host?: string;
  readonly number: number;
  readonly commentId: number;
  readonly body: string;
  readonly proxy?: string | null;
  readonly account?: string;
  readonly session?: string;
  readonly pid?: number;
}

/** One request to submit a pull request review as the host account. */
export interface HostReviewRequest {
  readonly kind: 'review';
  readonly repo: string;
  readonly host?: string;
  readonly number: number;
  readonly event: 'approve' | 'request-changes' | 'comment';
  readonly body: string;
  readonly proxy?: string | null;
  readonly account?: string;
  readonly session?: string;
  readonly pid?: number;
}

/** One request to edit a pull request's title, body or base as the host account. */
export interface HostEditRequest {
  readonly kind: 'edit';
  readonly repo: string;
  readonly host?: string;
  readonly number: number;
  readonly title?: string;
  readonly body?: string;
  readonly base?: string;
  readonly proxy?: string | null;
  readonly account?: string;
  readonly session?: string;
  readonly pid?: number;
}

/** One catalogued action to run as the host account. */
export interface HostActionRequest {
  readonly kind: 'action';
  readonly action: string;
  readonly repo: string;
  readonly host?: string;
  readonly values: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly proxy?: string | null;
  readonly account?: string;
  readonly session?: string;
  readonly pid?: number;
}

/** One request to fork a repository. */
export interface HostForkRequest {
  readonly kind: 'fork';
  readonly repo: string;
  readonly host?: string;
  readonly proxy?: string | null;
  readonly account?: string;
  readonly session?: string;
  readonly pid?: number;
}

/** A request the host broker can fulfil. */
export type HostRequest =
  | HostOpenRequest
  | HostReplyRequest
  | HostReviewRequest
  | HostEditRequest
  | HostActionRequest
  | HostForkRequest;

/** What the host broker answered. */
export interface HostResult {
  readonly number?: number;
  readonly url?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number | null;
  readonly error?: string;
}

/** The running host broker, as it advertises itself. */
export interface HostBrokerInfo {
  readonly pid?: number;
  readonly command?: string;
  readonly startedAt?: string;
  /** Request kinds this build can fulfil; absent means the pre-issue build. */
  readonly kinds?: readonly string[];
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
  // A symlinked .git is not a thing git makes: a submodule and a worktree use a file.
  if (lstatSync(candidate).isSymbolicLink()) return undefined;
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
  // resolve() is lexical: a symlink inside the checkout satisfies a prefix check while pointing at a
  // directory outside it, and the container can make one. The real path is what the containment check
  // downstream has to compare, so it is resolved here, where the pointer is still known.
  let resolved: string;
  try {
    resolved = realpathSync(resolve(dir, pointed));
  } catch {
    return undefined;
  }
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
 * The host broker is meant to be started once for a machine, so it is given roots rather than one
 * repository: every checkout below them is served, including ones created later. Dotted
 * directories are *not* skipped — a repository whose name begins with a dot is a checkout like any
 * other. A directory holding a checkout is not descended into, which keeps the walk cheap.
 *
 * @param root - where to start.
 * @param maxDepth - how many levels below the root to look.
 * @returns each checkout, with the channel directory that belongs to it.
 */
export function discoverCheckouts(root: string, maxDepth = 4): { repo: string; dir: string }[] {
  const found: { repo: string; dir: string }[] = [];
  // The root can be one name for a directory the filesystem knows by another, and a worktree records its
  // git directory under the real one. Both sides are canonical, or the plain checkout is served and the
  // worktree beside it is silently not.
  const realRoot = canonicalPath(root).replace(/[/\\]+$/, '');
  const walk = (current: string, depth: number): void => {
    const gitDir = gitDirAt(current);
    if (gitDir !== undefined) {
      // A `gitdir:` pointer is written by whoever has the checkout, which is the container. Serving a
      // channel at a path it names would let it choose where the host broker creates files, and running `gh`
      // there would let it choose which repository that checkout means. A worktree's pointer stays under
      // the same root.
      if (canonicalPath(gitDir).startsWith(`${realRoot}${sep}`)) {
        found.push({ repo: current, dir: channelDir(gitDir) });
      }
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
 * Read the host broker's marker.
 *
 * @param dir - the channel directory.
 * @returns what the host broker said about itself, or `undefined` when none is running.
 */
export function readHostBroker(dir: string): HostBrokerInfo | undefined {
  // Through readJson, which takes lstat and a size: a FIFO here would block open(2) forever, and it would
  // block synchronously, so one such file stops the host broker serving every root with nothing in the log.
  const parsed = readJson(join(dir, HOST_BROKER_FILE));
  return typeof parsed === 'object' && parsed !== null ? (parsed as HostBrokerInfo) : undefined;
}

/**
 * Write the host broker's marker.
 *
 * @param dir - the channel directory.
 * @param info - what to advertise.
 */
export function writeHostBroker(dir: string, info: HostBrokerInfo): void {
  writeJsonAtomic(join(dir, HOST_BROKER_FILE), info);
}

/**
 * Remove the host broker's marker.
 *
 * @param dir - the channel directory.
 */
export function clearHostBroker(dir: string): void {
  rmSync(join(dir, HOST_BROKER_FILE), { force: true });
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

/** A number that can name a real issue, pull request or comment. */
function isPositiveNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * What is wrong with a request, if anything.
 *
 * @param request - the request to check.
 * @returns one message per problem, empty when there is none.
 */
export function requestProblems(request: HostRequest): string[] {
  const problems: string[] = [];
  if (request.kind === 'reply') {
    if (!REPOSITORY.test(request.repo)) problems.push('the repository is not owner/name');
    if (request.host !== undefined && !HOST.test(request.host)) problems.push('the host is not a usable host');
    if (!isPositiveNumber(request.number)) problems.push('the pull request number is not positive');
    if (!isPositiveNumber(request.commentId)) {
      problems.push('the comment id is not positive');
    }
    if (request.body.trim() === '') problems.push('a reply needs a body');
    if (request.body.length > MAX_BODY_CHARS) problems.push(`the body must be at most ${MAX_BODY_CHARS} characters`);
    if (request.account !== undefined && !LOGIN.test(request.account)) {
      problems.push('the account is not a usable GitHub login');
    }
    return problems;
  }
  if (request.kind === 'review') {
    if (!REPOSITORY.test(request.repo)) problems.push('the repository is not owner/name');
    if (request.host !== undefined && !HOST.test(request.host)) problems.push('the host is not a usable host');
    if (!isPositiveNumber(request.number)) problems.push('the pull request number is not positive');
    if (request.event !== 'approve' && request.event !== 'request-changes' && request.event !== 'comment') {
      problems.push('the review event is not approve, request-changes or comment');
    }
    if (request.body.length > MAX_BODY_CHARS) problems.push(`the body must be at most ${MAX_BODY_CHARS} characters`);
    if (request.event !== 'approve' && request.body.trim() === '') problems.push('this review needs a body');
    if (request.account !== undefined && !LOGIN.test(request.account)) {
      problems.push('the account is not a usable GitHub login');
    }
    return problems;
  }
  if (request.kind === 'edit') {
    if (!REPOSITORY.test(request.repo)) problems.push('the repository is not owner/name');
    if (request.host !== undefined && !HOST.test(request.host)) problems.push('the host is not a usable host');
    if (!isPositiveNumber(request.number)) problems.push('the pull request number is not positive');
    if (request.title !== undefined && (request.title.trim() === '' || request.title.length > MAX_TITLE_CHARS)) {
      problems.push(`the title must be 1 to ${MAX_TITLE_CHARS} characters`);
    }
    if (request.body !== undefined && request.body.length > MAX_BODY_CHARS) {
      problems.push(`the body must be at most ${MAX_BODY_CHARS} characters`);
    }
    if (request.base !== undefined && (!BRANCH.test(request.base) || request.base.includes('..'))) {
      problems.push('the base branch name is not usable');
    }
    if (request.title === undefined && request.body === undefined && request.base === undefined) {
      problems.push('an edit needs a title, body or base');
    }
    if (request.account !== undefined && !LOGIN.test(request.account)) {
      problems.push('the account is not a usable GitHub login');
    }
    return problems;
  }
  if (request.kind === 'action') {
    if (!REPOSITORY.test(request.repo)) problems.push('the repository is not owner/name');
    if (request.host !== undefined && !HOST.test(request.host)) problems.push('the host is not a usable host');
    if (!/^[a-z]+:[a-z0-9-]+$/.test(request.action)) problems.push('the action name is not usable');
    if (request.values === null || typeof request.values !== 'object' || Array.isArray(request.values)) {
      problems.push('the action values are not an object');
    }
    if (request.account !== undefined && !LOGIN.test(request.account)) {
      problems.push('the account is not a usable GitHub login');
    }
    return problems;
  }
  if (request.kind === 'fork') {
    if (!REPOSITORY.test(request.repo)) problems.push('the repository is not owner/name');
    if (request.host !== undefined && !HOST.test(request.host)) problems.push('the host is not a usable host');
    if (request.account !== undefined && !LOGIN.test(request.account)) {
      problems.push('the account is not a usable GitHub login');
    }
    return problems;
  }
  if (request.repo !== undefined && !REPOSITORY.test(request.repo)) {
    problems.push('the repository is not owner/name');
  }
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
  if (request.account !== undefined && !LOGIN.test(request.account)) {
    problems.push('the account is not a usable GitHub login');
  }
  return problems;
}

/**
 * Write a request.
 *
 * @param dir - the channel directory.
 * @param request - what to ask for.
 * @returns the identifier the answer will carry.
 * @throws {Error} when the request is not one the host broker would accept.
 */
export function writeRequest(dir: string, request: HostRequest): string {
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
export function readRequest(dir: string, id: string): HostRequest | undefined {
  const parsed = readJson(join(dir, `${id}.json`)) as
    | (Partial<HostOpenRequest> &
        Partial<HostReplyRequest> &
        Partial<HostReviewRequest> &
        Partial<HostActionRequest> &
        Partial<HostForkRequest>)
    | undefined;
  if (!parsed) return undefined;
  if (parsed.kind === 'reply') {
    if (
      typeof parsed.repo !== 'string' ||
      !REPOSITORY.test(parsed.repo) ||
      typeof parsed.body !== 'string' ||
      typeof parsed.number !== 'number' ||
      typeof parsed.commentId !== 'number'
    ) {
      return undefined;
    }
    return {
      kind: 'reply',
      repo: parsed.repo,
      number: parsed.number,
      commentId: parsed.commentId,
      body: parsed.body,
      ...(typeof parsed.host === 'string' ? { host: parsed.host } : {}),
      ...(typeof parsed.proxy === 'string' || parsed.proxy === null ? { proxy: parsed.proxy } : {}),
      ...(typeof parsed.account === 'string' ? { account: parsed.account } : {}),
      session: parsed.session,
      pid: parsed.pid,
    };
  }
  if (parsed.kind === 'review') {
    if (
      typeof parsed.repo !== 'string' ||
      !REPOSITORY.test(parsed.repo) ||
      typeof parsed.body !== 'string' ||
      typeof parsed.number !== 'number' ||
      (parsed.event !== 'approve' && parsed.event !== 'request-changes' && parsed.event !== 'comment')
    ) {
      return undefined;
    }
    return {
      kind: 'review',
      repo: parsed.repo,
      number: parsed.number,
      event: parsed.event,
      body: parsed.body,
      ...(typeof parsed.host === 'string' ? { host: parsed.host } : {}),
      ...(typeof parsed.proxy === 'string' || parsed.proxy === null ? { proxy: parsed.proxy } : {}),
      ...(typeof parsed.account === 'string' ? { account: parsed.account } : {}),
      session: parsed.session,
      pid: parsed.pid,
    };
  }
  if (parsed.kind === 'edit') {
    if (
      typeof parsed.repo !== 'string' ||
      !REPOSITORY.test(parsed.repo) ||
      typeof parsed.number !== 'number' ||
      (parsed.title !== undefined && typeof parsed.title !== 'string') ||
      (parsed.body !== undefined && typeof parsed.body !== 'string') ||
      (parsed.base !== undefined && typeof parsed.base !== 'string')
    ) {
      return undefined;
    }
    return {
      kind: 'edit',
      repo: parsed.repo,
      number: parsed.number,
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
      ...(parsed.body === undefined ? {} : { body: parsed.body }),
      ...(parsed.base === undefined ? {} : { base: parsed.base }),
      ...(typeof parsed.host === 'string' ? { host: parsed.host } : {}),
      ...(typeof parsed.proxy === 'string' || parsed.proxy === null ? { proxy: parsed.proxy } : {}),
      ...(typeof parsed.account === 'string' ? { account: parsed.account } : {}),
      session: parsed.session,
      pid: parsed.pid,
    };
  }
  if (parsed.kind === 'action') {
    if (
      typeof parsed.repo !== 'string' ||
      !REPOSITORY.test(parsed.repo) ||
      typeof parsed.action !== 'string' ||
      parsed.values === null ||
      typeof parsed.values !== 'object' ||
      Array.isArray(parsed.values)
    ) {
      return undefined;
    }
    return {
      kind: 'action',
      action: parsed.action,
      repo: parsed.repo,
      values: parsed.values as HostActionRequest['values'],
      ...(typeof parsed.host === 'string' ? { host: parsed.host } : {}),
      ...(typeof parsed.proxy === 'string' || parsed.proxy === null ? { proxy: parsed.proxy } : {}),
      ...(typeof parsed.account === 'string' ? { account: parsed.account } : {}),
      session: parsed.session,
      pid: parsed.pid,
    };
  }
  if (parsed.kind === 'fork') {
    if (typeof parsed.repo !== 'string' || !REPOSITORY.test(parsed.repo)) return undefined;
    return {
      kind: 'fork',
      repo: parsed.repo,
      ...(typeof parsed.host === 'string' ? { host: parsed.host } : {}),
      ...(typeof parsed.proxy === 'string' || parsed.proxy === null ? { proxy: parsed.proxy } : {}),
      ...(typeof parsed.account === 'string' ? { account: parsed.account } : {}),
      session: parsed.session,
      pid: parsed.pid,
    };
  }
  if (typeof parsed.title !== 'string') return undefined;
  const common = {
    repo: typeof parsed.repo === 'string' ? parsed.repo : undefined,
    title: parsed.title,
    body: typeof parsed.body === 'string' ? parsed.body : '',
    ...(typeof parsed.proxy === 'string' || parsed.proxy === null ? { proxy: parsed.proxy } : {}),
    ...(typeof parsed.account === 'string' ? { account: parsed.account } : {}),
    session: parsed.session,
    pid: parsed.pid,
  };
  if (typeof parsed.head !== 'string' || typeof parsed.base !== 'string') return undefined;
  return { ...common, head: parsed.head, base: parsed.base, draft: parsed.draft === true };
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
    // a symlink to a host file — is aimed at the host broker rather than written by it.
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith('.json') &&
        !entry.name.endsWith('.result.json') &&
        entry.name !== HOST_BROKER_FILE,
    )
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .sort();
}

/**
 * Read an answer.
 *
 * @param dir - the channel directory.
 * @param id - the identifier of the request it answers.
 * @returns the answer, or `undefined` while the host broker has not replied.
 */
export function readResult(dir: string, id: string): HostResult | undefined {
  const parsed = readJson(join(dir, `${id}.result.json`)) as Partial<HostResult> | undefined;
  return parsed ?? undefined;
}

/** Per-stream JSON-escaped budget; two streams plus the envelope stay under the reader's cap. */
const MAX_STREAM_JSON_BYTES = 60_000;

/** Bytes one string contributes after JSON escaping. */
function jsonStringBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify(text)) - 2;
}

/** Trim a result stream until its JSON-escaped form fits the result envelope. */
function clampJsonStream(text: string): string {
  if (jsonStringBytes(text) <= MAX_STREAM_JSON_BYTES) return text;
  const suffix = '\n[output truncated]\n';
  let low = 0;
  let high = text.length;
  let best = suffix;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = text.slice(0, middle) + suffix;
    if (jsonStringBytes(candidate) <= MAX_STREAM_JSON_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

/**
 * Write an answer.
 *
 * @param dir - the channel directory.
 * @param id - the identifier of the request it answers.
 * @param result - what happened.
 */
export function writeResult(dir: string, id: string, result: HostResult): void {
  const bounded: HostResult = {
    ...result,
    ...(typeof result.stdout === 'string' ? { stdout: clampJsonStream(result.stdout) } : {}),
    ...(typeof result.stderr === 'string' ? { stderr: clampJsonStream(result.stderr) } : {}),
  };
  writeJsonAtomic(join(dir, `${id}.result.json`), { v: 1, id, ...bounded });
  writeJsonAtomic(doneFile(dir, id), { at: Date.now() });
}

/** The rename→record window; longer than run:watch's 3,300 s timeout plus setup/termination. */
const CLAIM_NO_RECORD_MS = 3_600_000;

/** A backstop for a reboot that reused the recorded pid. Longer than the longest catalogued timeout. */
const CLAIM_MAX_AGE_MS = 2 * 60 * 60_000;

/** The sidecar recording who claimed a request. */
function claimFile(dir: string, id: string): string {
  return join(dir, `${id}.claim`);
}

/** Evidence that the work finished, kept until the host removes the request. */
function doneFile(dir: string, id: string): string {
  return join(dir, `${id}.done`);
}

/**
 * Refresh a regular file's timestamps without following a symlink or blocking on a FIFO.
 *
 * @param file - the path to touch.
 */
function touchRegular(file: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(
      file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    if (!fstatSync(fd).isFile()) return;
    const now = new Date();
    futimesSync(fd, now, now);
  } catch {
    // A missing or replaced file simply keeps its old age; recovery stays fail-safe.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Whether a process is still alive.
 *
 * @param pid - the pid to probe.
 * @returns true when the process exists and this user may signal it.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** A pid a signal can name: positive, integer, and inside the OS range. */
function usablePid(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff
    ? value
    : undefined;
}

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
export function claimRequest(dir: string, id: string): HostRequest | undefined {
  let lock: string | undefined;
  try {
    lock = acquireReclaimLock(dir, id);
  } catch {
    return undefined;
  }
  if (lock === undefined) return undefined;
  try {
    const claimed = join(dir, `${id}.json.working`);
    try {
      renameSync(join(dir, `${id}.json`), claimed);
    } catch {
      return undefined;
    }
    try {
      const claim = claimFile(dir, id);
      rmSync(claim, { force: true, recursive: true });
      writeFileSync(claim, JSON.stringify({ pid: process.pid, at: Date.now() }), {
        mode: 0o600,
        flag: 'wx',
      });
    } catch {
      // The claim is only needed to reclaim a crashed claim; an unrecorded claim falls back to mtime.
    }
    touchRegular(claimed);
    const request = readJson(claimed) as HostRequest | undefined;
    const shaped =
      request !== undefined &&
      (request.account === undefined || typeof request.account === 'string') &&
      (request.kind === 'action'
        ? typeof request.repo === 'string' &&
          REPOSITORY.test(request.repo) &&
          typeof request.action === 'string' &&
          request.values !== null &&
          typeof request.values === 'object' &&
          !Array.isArray(request.values)
        : request.kind === 'edit'
        ? typeof request.repo === 'string' &&
          REPOSITORY.test(request.repo) &&
          Number.isInteger(request.number) &&
          (request.title === undefined || typeof request.title === 'string') &&
          (request.body === undefined || typeof request.body === 'string') &&
          (request.base === undefined || typeof request.base === 'string') &&
          (request.host === undefined || (typeof request.host === 'string' && HOST.test(request.host)))
        : request.kind === 'review'
        ? typeof request.repo === 'string' &&
          REPOSITORY.test(request.repo) &&
          typeof request.body === 'string' &&
          Number.isInteger(request.number) &&
          (request.event === 'approve' || request.event === 'request-changes' || request.event === 'comment') &&
          (request.host === undefined || (typeof request.host === 'string' && HOST.test(request.host)))
        : request.kind === 'reply'
        ? typeof request.repo === 'string' &&
          REPOSITORY.test(request.repo) &&
          typeof request.body === 'string' &&
          Number.isInteger(request.number) &&
          Number.isInteger(request.commentId) &&
          (request.host === undefined || (typeof request.host === 'string' && HOST.test(request.host)))
        : request.kind === 'fork'
        ? typeof request.repo === 'string' &&
          REPOSITORY.test(request.repo) &&
          (request.host === undefined || (typeof request.host === 'string' && HOST.test(request.host)))
        : typeof request.title === 'string' &&
          typeof request.body === 'string' &&
          typeof request.head === 'string' &&
          typeof request.base === 'string');
    if (!shaped) {
      rmSync(claimed, { force: true, recursive: true });
      rmSync(claimFile(dir, id), { force: true, recursive: true });
      return undefined;
    }
    return request;
  } finally {
    rmSync(lock, { force: true, recursive: true });
  }
}

/** A reclaim marker older than this is assumed to belong to a crashed reclaimer. */
const RECLAIM_LOCK_STALE_MS = 5 * 60_000;

/**
 * Take the per-request reclaim lock, so two sweeps cannot requeue the same claim.
 *
 * @param dir - the channel directory.
 * @param id - the request id.
 * @returns the lock path, or undefined when another sweep owns it.
 */
function acquireReclaimLock(dir: string, id: string): string | undefined {
  const lock = join(dir, `${id}.reclaim`);
  const temporary = `${lock}.${String(process.pid)}.${randomUUID()}.tmp`;
  writeFileSync(temporary, String(process.pid), { mode: 0o600, flag: 'wx' });
  try {
    linkSync(temporary, lock);
    return lock;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    try {
      if (Date.now() - statSync(lock).mtimeMs > RECLAIM_LOCK_STALE_MS)
        rmSync(lock, { force: true, recursive: true });
    } catch {
      // A vanished lock is retried on the next sweep.
    }
    return undefined;
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
}

/**
 * Put claims abandoned by a crashed host broker back in the queue.
 *
 * The rename in {@link claimRequest} makes exactly one opener win, but a crash after it leaves only a
 * `.working` file. A live claim is left alone; a dead one is renamed back, and a claim with no
 * readable record falls back to the file's age. An answer already written means the work finished and
 * the claim is simply removed, not retried.
 *
 * @param dir - the channel directory.
 * @returns the ids that were reclaimed.
 */
export function reclaimAbandoned(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const reclaimed: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json.working')) continue;
    const id = entry.name.slice(0, -'.json.working'.length);
    const claimed = join(dir, entry.name);
    let lock: string | undefined;
    try {
      lock = acquireReclaimLock(dir, id);
    } catch {
      continue;
    }
    if (lock === undefined) continue;
    try {
      if (readResult(dir, id) !== undefined || readJson(doneFile(dir, id)) !== undefined) {
        removeRequest(dir, id);
        reclaimed.push(id);
        continue;
      }
      const claim = readJson(claimFile(dir, id)) as { pid?: unknown; at?: unknown } | undefined;
      const pid = usablePid(claim?.pid);
      const at = typeof claim?.at === 'number' ? claim.at : undefined;
      let stale: boolean;
      if (pid === undefined) {
        let age: number;
        try {
          age = Date.now() - statSync(claimed).mtimeMs;
        } catch {
          continue;
        }
        stale = age >= CLAIM_NO_RECORD_MS;
      } else {
        stale = !pidAlive(pid) || (at !== undefined && Date.now() - at > CLAIM_MAX_AGE_MS);
      }
      if (!stale) continue;
      const countFile = join(dir, `${id}.reclaims`);
      const rawCount = readJson(countFile);
      const count =
        typeof rawCount === 'number' && Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : 0;
      if (count >= 1) {
        writeResult(dir, id, { error: `request ${id} was reclaimed twice; not retrying` });
        removeRequest(dir, id);
        reclaimed.push(id);
        continue;
      }
      try {
        renameSync(claimed, join(dir, `${id}.json`));
      } catch {
        continue;
      }
      // The reclaim lock excludes a new claimant, so the old sidecar can be removed after the
      // rename; a failed rename keeps it for the next recovery attempt.
      rmSync(claimFile(dir, id), { force: true, recursive: true });
      touchRegular(join(dir, `${id}.json`));
      try {
        rmSync(countFile, { force: true, recursive: true });
        writeFileSync(countFile, JSON.stringify(count + 1), { mode: 0o600, flag: 'wx' });
      } catch {
        writeResult(dir, id, { error: `could not record the retry count for ${id}` });
        removeRequest(dir, id);
        reclaimed.push(id);
        continue;
      }
      reclaimed.push(id);
    } finally {
      rmSync(lock, { force: true, recursive: true });
    }
  }
  return reclaimed;
}

/**
 * Remove a request, once it has been answered.
 *
 * @param dir - the channel directory.
 * @param id - the identifier.
 */
export function removeRequest(dir: string, id: string): void {
  // Recursive: a directory here is not a request, and it must not be able to make this throw. The claimed
  // copy goes too: only the host broker holding it reaches a removal, and only after answering or refusing, so
  // this is the release — without it every request left a copy of itself, body and all, in the git
  // directory, and nothing ever removed it.
  rmSync(join(dir, `${id}.json`), { force: true, recursive: true });
  rmSync(join(dir, `${id}.json.working`), { force: true, recursive: true });
  rmSync(claimFile(dir, id), { force: true, recursive: true });
  rmSync(join(dir, `${id}.reclaims`), { force: true, recursive: true });
  rmSync(doneFile(dir, id), { force: true, recursive: true });
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
): Promise<HostResult | undefined> {
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
  let fd: number | undefined;
  try {
    // Open without following a symlink and without blocking on a FIFO; lstat+read leaves a window
    // in which the container can replace the entry. The platform may not define O_NOFOLLOW; the
    // fstat check below still rejects anything that is not a regular file.
    fd = openSync(
      file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BODY_CHARS * 4) return undefined;
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
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
    // without O_EXCL a symlink here would choose which host file the host broker — running as a person — writes.
    exclusive(temp);
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    rmSync(temp, { force: true, recursive: true });
    exclusive(temp);
  }
  // A directory where the destination belongs would make the rename throw and take the host broker with it.
  try {
    if (!lstatSync(file).isFile()) rmSync(file, { force: true, recursive: true });
  } catch {
    // Not there at all, which is the usual case.
  }
  renameSync(temp, file);
}
