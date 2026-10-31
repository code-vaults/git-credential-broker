/** The client-side identity flags: the bare/value conflict. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { tryRunAsync } from '../common/run.ts';

const CLIENT_BIN = fileURLToPath(new URL('../../packages/client/bin/gcb.js', import.meta.url));

function checkout(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-pr-identity-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('gcb pr identity flags', () => {
  it('refuses a bare --as-user together with a login, in every spelling', async () => {
    const repo = checkout();
    try {
      const spellings: readonly string[][] = [
        ['--as-user', '--as-user', 'alice'],
        ['--as-user', 'alice', '--as-user'],
        ['--as-user=alice', '--as-user'],
        ['--as-user', '--as-user=alice'],
      ];
      for (const spelling of spellings) {
        const result = await tryRunAsync(
          process.execPath,
          [
            '--conditions=development',
            CLIENT_BIN,
            'pr',
            '--repo',
            'acme/widget',
            '--head',
            'feat/x',
            '--title',
            't',
            ...spelling,
          ],
          { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
        );
        assert.equal(result.status, 1, spelling.join(' '));
        assert.match(result.stderr, /cannot be both bare and given a login/u);
        assert.equal(
          fs.existsSync(path.join(repo.root, '.git', 'gcb', 'pr-requests')),
          false,
          spelling.join(' '),
        );
      }
    } finally {
      repo.cleanup();
    }
  });
});
