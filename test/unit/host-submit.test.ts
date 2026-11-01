/** The two ways an opener request can produce no answer. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { noAnswerMessage } from '../../packages/client/src/commands/host-submit.ts';
import { channelDir } from '../../packages/core/src/host-request.ts';

function fixture(): { dir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-no-answer-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  return { dir: channelDir(path.join(root, '.git')), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('an opener request without an answer', () => {
  it('says the request was taken and dropped when neither copy remains', () => {
    const host = fixture();
    try {
      fs.mkdirSync(host.dir, { recursive: true });
      const message = noAnswerMessage(host.dir, 'abc', 'issue', 180_000);
      assert.match(message, /took abc and dropped it/u);
      assert.match(message, /does not understand issue requests/u);
    } finally {
      host.cleanup();
    }
  });

  it('keeps the in-flight wording while either copy remains', () => {
    const host = fixture();
    try {
      fs.mkdirSync(host.dir, { recursive: true });
      fs.writeFileSync(path.join(host.dir, 'abc.json'), '{}');
      const inFlight = noAnswerMessage(host.dir, 'abc', 'pull request', 1_500);
      assert.match(inFlight, /within 2s/u);
      assert.match(inFlight, /may still be working/u);
      fs.rmSync(path.join(host.dir, 'abc.json'));
      fs.writeFileSync(path.join(host.dir, 'abc.json.working'), '{}');
      const claimedMessage = noAnswerMessage(host.dir, 'abc', 'pull request', 1_500);
      assert.match(claimedMessage, /within 2s/u);
      assert.match(claimedMessage, /may still be working/u);
    } finally {
      host.cleanup();
    }
  });
});
