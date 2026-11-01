/**
 * Submit one request to the host opener and wait for its answer.
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
  removeResult,
  waitForResult,
  writeRequest,
} from 'gcb-core';
import type { HostOpenResult, HostRequest } from 'gcb-core';
import { fail, say } from 'gcb-core';

/**
 * Explain why an opener request produced no answer.
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
      `the host opener took ${id} and dropped it without answering\n` +
      `  it probably does not understand ${noun} requests; restart it from this gcb-host version`
    );
  }
  return (
    `the host opener did not answer ${id} within ${Math.round(timeoutMs / 1000)}s\n` +
    '  it may still be working: the request is not cancelled, and the opener removes it only once\n' +
    `  it has created the ${noun} or failed. Check the ${noun} list before asking again.`
  );
}

/**
 * Write, wait for and report one opener request.
 *
 * @param request - the validated request.
 * @param success - formats the success line from the answer.
 * @returns 0 after the answer is reported.
 */
export async function submitToOpener(
  request: HostRequest,
  success: (answer: HostOpenResult) => string,
): Promise<number> {
  const noun = request.kind === 'issue' ? 'issue' : 'pull request';
  const gitDir = findGitDir(process.cwd());
  if (gitDir === undefined) fail('--as-user needs a git repository: run it from the checkout');
  const dir = channelDir(gitDir);
  const opener = readOpener(dir);
  if (opener === undefined) {
    fail(
      `no host opener is watching ${dir}\n` +
        '  start one on the host: gcb host-opener --repo <that checkout>\n' +
        '  or drop --as-user to open it as the app instead',
    );
  }
  if (request.kind === 'issue' && !(Array.isArray(opener.kinds) && opener.kinds.includes('issue'))) {
    fail('the host opener does not advertise issue support; restart it from this gcb-host version');
  }

  // writeRequest refuses what the opener would refuse — a title past its limit, a body past its limit,
  // a head equal to its base. It throws, and a stack trace tells the caller none of that.
  let id: string;
  try {
    id = writeRequest(dir, request);
  } catch (error) {
    fail((error as Error).message);
  }
  // A short override makes the timeout path testable without a 180-second test; absent means the
  // contract value.
  const configured = Number(process.env['GCB_OPENER_TIMEOUT_MS']);
  const timeoutMs = Number.isInteger(configured) && configured > 0 ? configured : ANSWER_TIMEOUT_MS;
  let answer = await waitForResult(dir, id, timeoutMs);
  // A result can land between the deadline and the cleanup. Re-read before claiming the request
  // disappeared; deleting it first would turn a successful, late answer into a false "dropped".
  if (answer === undefined) answer = await waitForResult(dir, id, 300, 50);
  if (answer === undefined) fail(noAnswerMessage(dir, id, noun, timeoutMs));
  removeResult(dir, id);
  if (answer.error !== undefined) fail(`the host opener could not open it: ${answer.error}`);
  say(success(answer));
  return 0;
}
