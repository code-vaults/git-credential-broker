/** The client-side identity flags: the bare/value conflict. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { sleep, tryRunAsync } from '../common/run.ts';
import { channelDir, listRequests, readRequest, writeOpener, writeResult } from '../../packages/core/src/host-request.ts';

const CLIENT_BIN = fileURLToPath(new URL('../../packages/client/bin/gcb.js', import.meta.url));

async function listen(
  socketPath: string,
  onRequest: (request: Record<string, unknown>) => void,
  extra: Record<string, unknown> = {},
): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      onRequest(JSON.parse(chunk.toString().split('\n')[0] ?? '{}') as Record<string, unknown>);
      socket.end(
        JSON.stringify({
          ok: true,
          prNumber: 7,
          prUrl: 'https://example.test/pull/7',
          prStatus: 'resolved',
          ...extra,
        }) + '\n',
      );
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
        assert.equal(result.status, 0, extra.join(' ') + '\n' + result.stderr);
        assert.equal(seen, expected, extra.join(' '));
      }
    } finally {
      repo.cleanup();
    }
  });

  it('routes pr create as-user=login spellings to the opener', async () => {
    const repo = checkout();
    try {
      for (const spelling of ['--as-user=alice', '-as-user=alice']) {
        const result = await tryRunAsync(
          process.execPath,
          [
            '--conditions=development',
            CLIENT_BIN,
            'pr',
            'create',
            spelling,
            '--repo',
            'acme/widget',
            '--head',
            'feat/x',
            '--title',
            't',
          ],
          { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
        );
        assert.equal(result.status, 1, spelling);
        assert.match(result.stderr, /no host broker is watching/, spelling);
      }
    } finally {
      repo.cleanup();
    }
  });

  it('refuses --host other than github.com when --repo is explicit', async () => {
    const repo = checkout();
    try {
      const result = await tryRunAsync(
        process.execPath,
        [
          '--conditions=development',
          CLIENT_BIN,
          'pr',
          'create',
          '--as-user',
          'alice',
          '--host',
          'ghe.example',
          '--repo',
          'acme/widget',
          '--head',
          'feat/x',
          '--title',
          't',
        ],
        { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /only targets github\.com/);
    } finally {
      repo.cleanup();
    }
  });

  it('keeps pr create without as-user on the catalog', async () => {
    const repo = checkout();
    const socketPath = path.join(repo.root, 'broker.sock');
    try {
      let seen: Record<string, unknown> = {};
      const server = await listen(
        socketPath,
        (request) => {
          seen = request;
        },
        { exitCode: 0 },
      );
      const result = await tryRunAsync(
        process.execPath,
        [
          '--conditions=development',
          CLIENT_BIN,
          'pr',
          'create',
          '--repo',
          'acme/widget',
          '--head',
          'feat/x',
          '--base',
          'main',
          '--title',
          't',
          '--body',
          'b',
          '--socket',
          socketPath,
        ],
        { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.equal(result.status, 0);
      assert.equal(seen['ghAction'], 'pr:create');
      assert.ok(seen['identity'] === undefined || seen['identity'] === 'app');
    } finally {
      repo.cleanup();
    }
  });

  it('sends the user identity for as-user edit and comment', async () => {
    const repo = checkout();
    const socketPath = path.join(repo.root, 'broker.sock');
    try {
      const cases: readonly string[][] = [
        ['--edit', '123', '--body', 'fixed'],
        ['--number', '7', '--comment', '--file', 'a.ts', '--line', '1', '--body', 'note'],
        ['--number', '7', '--approve'],
        ['--number', '7', '--review-comment', '--body=--approve'],
        ['--number', '7', '--title', 'fixed'],
      ];
      for (const extra of cases) {
        let seen: Record<string, unknown> = {};
        const server = await listen(socketPath, (request) => {
          seen = request;
        }, { exitCode: 0 });
        const result = await tryRunAsync(
          process.execPath,
          [
            '--conditions=development',
            CLIENT_BIN,
            'pr',
            '--as-user',
            '--repo',
            'acme/widget',
            '--socket',
            socketPath,
            ...extra,
          ],
          { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
        );
        await new Promise<void>((resolve) => server.close(() => resolve()));
        assert.equal(result.status, 0, extra.join(' '));
        assert.equal(seen['identity'], 'user', extra.join(' '));
        if (extra.includes('--approve')) {
          assert.equal(seen['ghAction'], 'pr:review');
          assert.deepEqual(seen['values'], { number: '7', approve: true });
        }
        if (extra.includes('--body=--approve')) {
          assert.equal((seen['values'] as Record<string, unknown>)['body'], '--approve');
        }
        if (extra.includes('--title')) {
          assert.equal(seen['ghAction'], 'pr:edit');
          assert.equal((seen['values'] as Record<string, unknown>)['title'], 'fixed');
        }
      }
    } finally {
      repo.cleanup();
    }
  });

  it('sends a login reply through the host broker', async () => {
    const repo = checkout();
    const dir = channelDir(path.join(repo.root, '.git'));
    try {
      writeOpener(dir, { pid: process.pid, kinds: ['reply'] });
      const pending = tryRunAsync(
        process.execPath,
        [
          '--conditions=development',
          CLIENT_BIN,
          'pr',
          '--as-user',
          'alice',
          '--number',
          '7',
          '--reply-to',
          '123',
          '--body',
          'a reply',
          '--repo',
          'acme/widget',
        ],
        { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
      );
      let request;
      for (let attempt = 0; attempt < 100 && request === undefined; attempt += 1) {
        const [id] = listRequests(dir);
        request = id === undefined ? undefined : readRequest(dir, id);
        if (request === undefined) await sleep(10);
      }
      assert.ok(request, 'the request reached the host broker');
      assert.equal(request?.kind, 'reply');
      assert.equal(request?.account, 'alice');
      assert.equal(request?.repo, 'acme/widget');
      assert.equal(request?.number, 7);
      assert.equal(request?.commentId, 123);
      assert.equal(request?.body, 'a reply');
      const [id] = listRequests(dir);
      writeResult(dir, id as string, {
        number: 7,
        url: 'https://github.com/acme/widget/pull/7#discussion_r1',
      });
      const result = await pending;
      assert.equal(result.status, 0);
      assert.match(result.stdout, /replied on #7 as alice/);
    } finally {
      repo.cleanup();
    }
  });

  it('sends an explicit repo on a host-broker create', async () => {
    const repo = checkout();
    const dir = channelDir(path.join(repo.root, '.git'));
    try {
      writeOpener(dir, { pid: process.pid, kinds: ['pull-request'] });
      const pending = tryRunAsync(
        process.execPath,
        [
          '--conditions=development',
          CLIENT_BIN,
          'pr',
          'create',
          '--as-user',
          'alice',
          '--repo',
          'acme/widget',
          '--head',
          'feat/x',
          '--title',
          'a title',
        ],
        { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
      );
      let id: string | undefined;
      let request;
      for (let attempt = 0; attempt < 100 && request === undefined; attempt += 1) {
        [id] = listRequests(dir);
        request = id === undefined ? undefined : readRequest(dir, id);
        if (request === undefined) await sleep(10);
      }
      assert.ok(request, 'the request reached the host broker');
      assert.equal(request?.repo, 'acme/widget');
      writeResult(dir, id as string, { number: 7, url: 'https://github.com/acme/widget/pull/7' });
      const result = await pending;
      assert.equal(result.status, 0);
    } finally {
      repo.cleanup();
    }
  });

  it('does not turn a checkout-derived repo into an explicit one', async () => {
    const repo = checkout();
    execFileSync('git', ['init', '-q'], { cwd: repo.root });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widget.git'], { cwd: repo.root });
    const dir = channelDir(path.join(repo.root, '.git'));
    try {
      writeOpener(dir, { pid: process.pid, kinds: ['pull-request'] });
      const pending = tryRunAsync(
        process.execPath,
        [
          '--conditions=development',
          CLIENT_BIN,
          'pr',
          'create',
          '--as-user',
          'alice',
          '--head',
          'feat/x',
          '--title',
          'a title',
        ],
        { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
      );
      let id: string | undefined;
      let request;
      for (let attempt = 0; attempt < 100 && request === undefined; attempt += 1) {
        [id] = listRequests(dir);
        request = id === undefined ? undefined : readRequest(dir, id);
        if (request === undefined) await sleep(10);
      }
      assert.ok(request, 'the request reached the host broker');
      assert.equal(request?.repo, undefined);
      writeResult(dir, id as string, { number: 7, url: 'https://github.com/acme/widget/pull/7' });
      const result = await pending;
      assert.equal(result.status, 0);
    } finally {
      repo.cleanup();
    }
  });

  it('sends a host review with the selected event and body', async () => {
    const repo = checkout();
    const dir = channelDir(path.join(repo.root, '.git'));
    try {
      writeOpener(dir, { pid: process.pid, kinds: ['review'] });
      const pending = tryRunAsync(
        process.execPath,
        [
          '--conditions=development',
          CLIENT_BIN,
          'pr',
          '--as-user',
          'alice',
          '--number',
          '7',
          '--review-comment',
          '--body',
          'looks good',
          '--repo',
          'acme/widget',
        ],
        { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
      );
      let id: string | undefined;
      let request;
      for (let attempt = 0; attempt < 100 && request === undefined; attempt += 1) {
        [id] = listRequests(dir);
        request = id === undefined ? undefined : readRequest(dir, id);
        if (request === undefined) await sleep(10);
      }
      assert.ok(request, 'the review reached the host broker');
      assert.equal(request?.kind, 'review');
      assert.equal(request?.event, 'comment');
      assert.equal(request?.body, 'looks good');
      assert.equal(request?.number, 7);
      writeResult(dir, id as string, { number: 7, url: 'https://github.com/acme/widget/pull/7#pullrequestreview-9' });
      const result = await pending;
      assert.equal(result.status, 0);
      assert.match(result.stdout, /submitted comment review on #7 as alice/u);
    } finally {
      repo.cleanup();
    }
  });

  it('sends an edit with the login through the host broker', async () => {
    const repo = checkout();
    const dir = channelDir(path.join(repo.root, '.git'));
    try {
      writeOpener(dir, { pid: process.pid, kinds: ['edit'] });
      const pending = tryRunAsync(
        process.execPath,
        [
          '--conditions=development',
          CLIENT_BIN,
          'pr',
          '--as-user',
          'alice',
          '--number',
          '7',
          '--title',
          'fixed',
          '--repo',
          'acme/widget',
        ],
        { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
      );
      let id: string | undefined;
      let request;
      for (let attempt = 0; attempt < 100 && request === undefined; attempt += 1) {
        [id] = listRequests(dir);
        request = id === undefined ? undefined : readRequest(dir, id);
        if (request === undefined) await sleep(10);
      }
      assert.ok(request, 'the edit reached the host broker');
      assert.equal(request?.kind, 'edit');
      assert.equal(request?.title, 'fixed');
      writeResult(dir, id as string, { number: 7, url: 'https://github.com/acme/widget/pull/7' });
      const result = await pending;
      assert.equal(result.status, 0);
      assert.match(result.stdout, /edited #7 as alice/u);
    } finally {
      repo.cleanup();
    }
  });

  it('refuses a review comment without a body', async () => {
    const repo = checkout();
    try {
      const result = await tryRunAsync(
        process.execPath,
        [
          '--conditions=development',
          CLIENT_BIN,
          'pr',
          '--as-user',
          '--number',
          '7',
          '--review-comment',
          '--repo',
          'acme/widget',
        ],
        { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /review-comment needs --body or --body-file/u);
    } finally {
      repo.cleanup();
    }
  });

  it('keeps a plain reply on the app identity', async () => {
    const repo = checkout();
    const socketPath = path.join(repo.root, 'broker.sock');
    try {
      let seen: Record<string, unknown> = {};
      const server = await listen(socketPath, (request) => {
        seen = request;
      });
      const result = await tryRunAsync(
        process.execPath,
        [
          '--conditions=development',
          CLIENT_BIN,
          'pr',
          '--number',
          '7',
          '--reply-to',
          '123',
          '--body',
          'a reply',
          '--repo',
          'acme/widget',
          '--socket',
          socketPath,
        ],
        { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.equal(result.status, 0);
      assert.equal(seen['identity'], 'app');
    } finally {
      repo.cleanup();
    }
  });

  it('sends the user identity for an as-user reply', async () => {
    const repo = checkout();
    const socketPath = path.join(repo.root, 'broker.sock');
    try {
      let seen: Record<string, unknown> = {};
      const server = await listen(socketPath, (request) => {
        seen = request;
      });
      const result = await tryRunAsync(
        process.execPath,
        [
          '--conditions=development',
          CLIENT_BIN,
          'pr',
          '--number',
          '7',
          '--reply-to',
          '123',
          '--body',
          'a reply',
          '--as-user',
          '--repo',
          'acme/widget',
          '--socket',
          socketPath,
        ],
        { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.equal(result.status, 0);
      assert.equal(seen['identity'], 'user');
    } finally {
      repo.cleanup();
    }
  });

  it('accepts pr create --as-user as the lifecycle spelling', async () => {
    const repo = checkout();
    const socketPath = path.join(repo.root, 'broker.sock');
    try {
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
          'create',
          '--as-user',
          '--repo',
          'acme/widget',
          '--head',
          'feat/x',
          '--title',
          't',
          '--socket',
          socketPath,
        ],
        { cwd: repo.root, env: process.env, timeoutMs: 5_000 },
      );
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert.equal(result.status, 0);
      assert.equal(seen, 'user');
    } finally {
      repo.cleanup();
    }
  });
});
