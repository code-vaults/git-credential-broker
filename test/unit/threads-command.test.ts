/** `pr --threads` must fail loudly rather than print nothing when the broker omits the report. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { tryRunAsync } from '../common/run.ts';

const CLIENT_BIN = fileURLToPath(new URL('../../packages/client/bin/gcb.js', import.meta.url));

describe('gcb pr --threads', () => {
  it('refuses an empty report instead of printing nothing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-threads-'));
    const socketPath = path.join(root, 'broker.sock');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        socket.end(JSON.stringify({ ok: true }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const result = await tryRunAsync(
        process.execPath,
        [
          '--conditions=development',
          CLIENT_BIN,
          'pr',
          '--threads',
          '--repo',
          'acme/widget',
          '--number',
          '7',
          '--socket',
          socketPath,
        ],
        { cwd: root, env: process.env, timeoutMs: 5_000 },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /returned no review-thread report/u);
      assert.equal(result.stdout, '');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
