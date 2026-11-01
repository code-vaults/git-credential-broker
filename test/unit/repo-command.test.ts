/** The client half of `repo fork`: identity requirement and the broker request. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { tryRunAsync, type RunResult } from '../common/run.ts';

const CLIENT_BIN = fileURLToPath(new URL('../../packages/client/bin/gcb.js', import.meta.url));

function runClient(args: readonly string[], cwd: string): Promise<RunResult> {
  return tryRunAsync(process.execPath, ['--conditions=development', CLIENT_BIN, ...args], {
    cwd,
    env: process.env,
    timeoutMs: 5_000,
  });
}

function checkout(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-repo-fork-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('gcb repo fork', () => {
  it('requires --as-user because an app cannot own a fork', async () => {
    const repo = checkout();
    try {
      const result = await runClient(['repo', 'fork', 'acme/widget'], repo.root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--as-user is required for fork/u);
    } finally {
      repo.cleanup();
    }
  });

  it('refuses a bare --as-user together with a login', async () => {
    const repo = checkout();
    try {
      const result = await runClient(
        ['repo', 'fork', 'acme/widget', '--as-user', '--as-user', 'alice'],
        repo.root,
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /cannot be both bare and given a login/u);
    } finally {
      repo.cleanup();
    }
  });

  it('sends a fork request with the user identity', async () => {
    const repo = checkout();
    const socketPath = path.join(repo.root, 'broker.sock');
    let seen: Record<string, unknown> = {};
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        seen = JSON.parse(chunk.toString().split('\n')[0] ?? '{}') as Record<string, unknown>;
        socket.end(JSON.stringify({ ok: true, prUrl: 'https://github.com/me/widget' }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const result = await runClient(
        ['repo', 'fork', 'acme/widget', '--as-user', '--socket', socketPath],
        repo.root,
      );
      assert.equal(result.status, 0);
      assert.match(result.stdout, /forked acme\/widget: https:\/\/github\.com\/me\/widget/u);
      assert.equal(seen['op'], 'pull-request');
      assert.equal(seen['action'], 'fork');
      assert.equal(seen['identity'], 'user');
      assert.equal(seen['path'], 'acme/widget');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      repo.cleanup();
    }
  });
});
