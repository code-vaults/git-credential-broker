/** The client-side identity flags: the bare/value conflict. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { tryRunAsync } from '../common/run.ts';

const CLIENT_BIN = fileURLToPath(new URL('../../packages/client/bin/gcb.js', import.meta.url));

async function listen(socketPath: string, onRequest: (request: Record<string, unknown>) => void): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      onRequest(JSON.parse(chunk.toString().split('\n')[0] ?? '{}') as Record<string, unknown>);
      socket.end(JSON.stringify({ ok: true, prNumber: 7, prUrl: 'https://example.test/pull/7', prStatus: 'resolved' }) + '\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

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

  it('sends the identity the selected route implies', async () => {
    const repo = checkout();
    const socketPath = path.join(repo.root, 'broker.sock');
    try {
      const cases: [readonly string[], string][] = [
        [[], 'app'],
        [['--as-user'], 'user'],
        [['--resolve', 'T1'], 'user'],
      ];
      for (const [extra, expected] of cases) {
        let seen: unknown;
        const server = await listen(socketPath, (request) => {
          seen = request['identity'];
        });
        const result = await tryRunAsync(
          process.execPath,
          [
            '--conditions=development',
            CLIENT_BIN,
            'pr',
            '--repo',
            'acme/widget',
            ...(extra.includes('--resolve') ? [] : ['--head', 'feat/x', '--title', 't']),
            '--socket',
            socketPath,
            ...extra,
          ],
          { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
        );
        await new Promise<void>((resolve) => server.close(() => resolve()));
        assert.equal(result.status, 0, extra.join(' '));
        assert.equal(seen, expected, extra.join(' '));
      }
    } finally {
      repo.cleanup();
    }
  });
});
