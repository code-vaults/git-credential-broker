/**
 * Submit one request to the host broker and wait for its answer.
 *
 * Both person-authored create routes (`pr --as-user` and `issue create --as-user`) use this, so the
 * channel checks, capability check, timeout diagnosis and cleanup cannot drift apart.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  ANSWER_TIMEOUT_MS,
  channelDir,
  findGitDir,
  readOpener,
  readResult,
  removeResult,
  requestProblems,
  waitForResult,
  writeRequest,
} from 'gcb-core';
import type { HostActionRequest, HostOpenResult, HostRequest } from 'gcb-core';
import { fail, getGhAction, say } from 'gcb-core';

/**
 * Explain why a host-broker request produced no answer.
 *
 * @param dir - the channel directory.
 * @param id - the request id.
 * @param noun - `pull request` or `issue`.
 * @param timeoutMs - the wait that elapsed.
 * @returns the message to show the caller.
 */
export function noAnswerMessage(dir: string, id: string, noun: string, timeoutMs: number): string {
  const pending = existsSync(join(dir, `${id}.json`));
  const claimed = existsSync(join(dir, `${id}.json.working`));
  if (!pending && !claimed) {
    return (
      `the host broker took ${id} and dropped it without answering\n` +
      `  it probably does not understand ${noun} requests; restart it from this gcb-host version`
    );
  }
  const elapsed = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)}s` : `${timeoutMs}ms`;
  return (
    `the host broker did not answer ${id} within ${elapsed}\n` +
    '  it may still be working: the request is not cancelled, and the host broker removes it only once\n' +
    `  it has created the ${noun} or failed. Check the ${noun} list before asking again.`
  );
}

/** How each request kind is named, and the capability an older host broker may lack. */
type RequestKind = NonNullable<HostRequest['kind']>;
const KINDS: Readonly<Record<RequestKind, { noun: string; needed?: string }>> = {
  'pull-request': { noun: 'pull request' },
  fork: { noun: 'fork', needed: 'fork' },
  reply: { noun: 'reply', needed: 'reply' },
  edit: { noun: 'edit', needed: 'edit' },
  review: { noun: 'review', needed: 'review' },
  action: { noun: 'action', needed: 'action' },
};

/** Write, wait for and return one host-broker answer. */
async function exchange(
  request: HostRequest,
  timeoutMs: number = ANSWER_TIMEOUT_MS,
  claimedTimeoutMs?: number,
): Promise<HostOpenResult> {
  const problems = requestProblems(request);
  if (problems.length > 0) fail(problems.join('; '));
  const { noun, needed } = KINDS[request.kind ?? 'pull-request'];
  const gitDir = findGitDir(process.cwd());
  if (gitDir === undefined) fail('--as-user needs a git repository: run it from the checkout');
  const dir = channelDir(gitDir);
  const opener = readOpener(dir);
  if (opener === undefined) {
    fail(
      `no host broker is watching ${dir}\n` +
        '  start one on the host: gcb host --repo <that checkout>\n' +
        '  or drop --as-user to do it as the app instead',
    );
  }
  if (needed !== undefined && !(Array.isArray(opener.kinds) && opener.kinds.includes(needed))) {
    fail(`the host broker does not advertise ${needed} support; restart it from this gcb-host version`);
  }

  let id: string;
  try {
    id = writeRequest(dir, request);
  } catch (error) {
    fail((error as Error).message);
  }
  const configured = Number(process.env['GCB_OPENER_TIMEOUT_MS']);
  if (Number.isInteger(configured) && configured > 0) {
    timeoutMs = configured;
    if (claimedTimeoutMs !== undefined) claimedTimeoutMs = Math.min(claimedTimeoutMs, configured);
  }
  let answer = await waitForAnswer(dir, id, timeoutMs, claimedTimeoutMs);
  if (answer === undefined) answer = await waitForResult(dir, id, 300, 50);
  if (answer === undefined) {
    const waited =
      claimedTimeoutMs !== undefined && existsSync(join(dir, `${id}.json.working`))
        ? claimedTimeoutMs
        : timeoutMs;
    fail(noAnswerMessage(dir, id, noun, waited));
  }
  removeResult(dir, id);
  return answer;
}

/**
 * Wait for an answer, giving a claimed request its own deadline after queue time.
 *
 * Without this the action timeout would start when the request was written, so a request claimed
 * late could still be running when the client reported it lost.
 */
async function waitForAnswer(
  dir: string,
  id: string,
  queueTimeoutMs: number,
  claimedTimeoutMs: number | undefined,
): Promise<HostOpenResult | undefined> {
  const queueDeadline = Date.now() + queueTimeoutMs;
  let claimedDeadline: number | undefined;
  for (;;) {
    const answer = readResult(dir, id);
    if (answer !== undefined) return answer;
    const now = Date.now();
    if (claimedTimeoutMs !== undefined && existsSync(join(dir, `${id}.json.working`))) {
      claimedDeadline ??= now + claimedTimeoutMs;
      if (now >= claimedDeadline) return undefined;
    } else if (now >= queueDeadline) {
      return undefined;
    }
    await new Promise((done) => setTimeout(done, 50));
  }
}

/**
 * Write, wait for and report one host-broker request.
 *
 * @param request - the validated request.
 * @param success - formats the success line from the answer.
 * @returns 0 after the answer is reported.
 */
export async function submitToHostBroker(
  request: HostRequest,
  success: (answer: HostOpenResult) => string,
): Promise<number> {
  const answer = await exchange(request);
  if (answer.error !== undefined) fail(`the host broker could not do it: ${answer.error}`);
  say(success(answer));
  return 0;
}

/**
 * Run one catalogued action through the host broker and forward its output.
 *
 * @param request - the validated action request.
 * @returns the child's exit status as 0 or 1.
 */
export async function submitActionToHostBroker(request: HostActionRequest): Promise<number> {
  const action = getGhAction(request.action);
  const answer = await exchange(
    request,
    ANSWER_TIMEOUT_MS,
    action.timeoutSeconds * 1_000 + 30_000,
  );
  if (answer.error !== undefined) fail(`the host broker could not do it: ${answer.error}`);
  if (answer.stdout !== undefined && answer.stdout !== '') process.stdout.write(answer.stdout);
  if (answer.stderr !== undefined && answer.stderr !== '') process.stderr.write(answer.stderr);
  return answer.code === 0 ? 0 : 1;
}
