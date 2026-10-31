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
  if (request.kind === 'issue' && !opener.kinds?.includes('issue')) {
    fail('the host opener does not advertise issue support; restart it from this gcb-host version');
  }

  let id: string;
  try {
    id = writeRequest(dir, request);
  } catch (error) {
    fail((error as Error).message);
  }
  const answer = await waitForResult(dir, id, ANSWER_TIMEOUT_MS);
  removeResult(dir, id);
  if (answer === undefined) {
    const pending = existsSync(join(dir, `${id}.json`));
    const claimed = existsSync(join(dir, `${id}.json.working`));
    if (!pending && !claimed) {
      fail(
        `the host opener took ${id} and dropped it without answering\n` +
          `  it probably does not understand ${noun} requests; restart it from this gcb-host version`,
      );
    }
    fail(
      `the host opener did not answer ${id} within ${Math.round(ANSWER_TIMEOUT_MS / 1000)}s\n` +
        '  it may still be working: the request is not cancelled, and the opener removes it only once\n' +
        `  it has created the ${noun} or failed. Check the ${noun} list before asking again.`,
    );
  }
  if (answer.error !== undefined) fail(`the host opener could not open it: ${answer.error}`);
  say(success(answer));
  return 0;
}
