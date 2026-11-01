/**
 * The client half of the person-authored issue route: flag refusals, the opener capability gate,
 * and one successful submission answered by a fake opener.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  channelDir,
  listRequests,
  readRequest,
  writeOpener,
  writeResult,
} from '../../packages/core/src/host-request.ts';
import { sleep, tryRunAsync, type RunResult } from '../common/run.ts';

const CLIENT_BIN = fileURLToPath(new URL('../../packages/client/bin/gcb.js', import.meta.url));

function runClient(
  args: readonly string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return tryRunAsync(process.execPath, ['--conditions=development', CLIENT_BIN, ...args], {
    cwd,
    env: { ...process.env, ...extraEnv },
    timeoutMs: 5_000,
  });
}

function fixture(): { root: string; dir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-issue-client-'));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  const dir = channelDir(path.join(root, '.git'));
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function requests(dir: string): string[] {
  return listRequests(dir);
}

describe('gcb issue create --as-user', () => {
  it('refuses when no opener is present', async () => {
    const host = fixture();
    try {
      const result = await runClient(['issue', 'create', '--as-user', 'alice', '--title', 't'], host.root);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /no host opener is watching/);
    } finally {
      host.cleanup();
    }
  });

  it('refuses every capability shape that is not an issue array', async () => {
    const variants: unknown[] = [undefined, 5, 'issue', ['pull-request'], null];
    for (const kinds of variants) {
      const host = fixture();
      try {
        writeOpener(host.dir, { pid: process.pid, ...(kinds === undefined ? {} : { kinds: kinds as string[] }) });
        const result = await runClient(['issue', 'create', '--as-user', 'alice', '--title', 't'], host.root);
        assert.equal(result.status, 1, JSON.stringify(kinds));
        assert.match(result.stderr, /does not advertise issue support/u);
        assert.deepEqual(requests(host.dir), [], 'no request is written before the gate');
      } finally {
        host.cleanup();
      }
    }
  });

  it('submits to an opener that advertises issue support', async () => {
    const host = fixture();
    try {
      writeOpener(host.dir, { pid: process.pid, kinds: ['issue'] });
      const pending = runClient(
        [
          'issue',
          'create',
          '--as-user',
          'alice',
          '--title',
          'a title',
          '--body',
          'a body',
          '--proxy',
          'http://p:1',
        ],
        host.root,
      );
      let id: string | undefined;
      for (let attempt = 0; attempt < 100 && id === undefined; attempt += 1) {
        id = requests(host.dir)[0];
        if (id === undefined) await sleep(10);
      }
      assert.ok(id !== undefined, 'the client wrote the request');
      const request = readRequest(host.dir, id);
      assert.equal(request?.kind, 'issue');
      assert.equal(request?.title, 'a title');
      assert.equal(request?.body, 'a body');
      assert.equal(request?.account, 'alice');
      assert.equal(request?.proxy, 'http://p:1');
      writeResult(host.dir, id, { number: 42, url: 'https://github.com/acme/widget/issues/42' });
      const result = await pending;
      assert.equal(result.status, 0);
      assert.match(result.stdout, /opened issue #42 as alice: https:\/\/github\.com\/acme\/widget\/issues\/42/u);
    } finally {
      host.cleanup();
    }
  });

  it('reports a request the opener took and dropped', async () => {
    const host = fixture();
    try {
      writeOpener(host.dir, { pid: process.pid, kinds: ['issue'] });
      const pending = runClient(
        ['issue', 'create', '--as-user', 'alice', '--title', 't'],
        host.root,
        { GCB_OPENER_TIMEOUT_MS: '1200' },
      );
      let id: string | undefined;
      for (let attempt = 0; attempt < 100 && id === undefined; attempt += 1) {
        id = requests(host.dir)[0];
        if (id === undefined) await sleep(10);
      }
      assert.ok(id !== undefined, 'the client wrote the request');
      fs.rmSync(path.join(host.dir, id + '.json'), { force: true });
      const result = await pending;
      assert.equal(result.status, 1);
      assert.match(result.stderr, /took .* and dropped it without answering/u);
      assert.match(result.stderr, /does not understand issue requests/u);
    } finally {
      host.cleanup();
    }
  });

  it('keeps the in-flight wording when the request is still present', async () => {
    const host = fixture();
    try {
      writeOpener(host.dir, { pid: process.pid, kinds: ['issue'] });
      const pending = runClient(
        ['issue', 'create', '--as-user', 'alice', '--title', 't'],
        host.root,
        { GCB_OPENER_TIMEOUT_MS: '1200' },
      );
      let id: string | undefined;
      for (let attempt = 0; attempt < 100 && id === undefined; attempt += 1) {
        id = requests(host.dir)[0];
        if (id === undefined) await sleep(10);
      }
      assert.ok(id !== undefined, 'the client wrote the request');
      const result = await pending;
      assert.equal(result.status, 1);
      assert.match(result.stderr, /within 1s/u);
      assert.match(result.stderr, /may still be working/u);
    } finally {
      host.cleanup();
    }
  });

  it('keeps the catalogue help and refuses --as-user outside create', async () => {
    const host = fixture();
    try {
      const catalogue = await runClient(['issue', '--help'], host.root);
      assert.equal(catalogue.status, 0);
      assert.match(catalogue.stdout, /Usage: gcb gh/u);

      const view = await runClient(['issue', 'view', '--help'], host.root);
      assert.equal(view.status, 0);
      assert.match(view.stdout, /Usage: gcb gh/u);

      const create = await runClient(['issue', 'create', '--help'], host.root);
      assert.equal(create.status, 0);
      assert.match(create.stdout, /Usage: gcb issue create --as-user/u);

      const top = await runClient(['issue', '--as-user'], host.root);
      assert.equal(top.status, 1);
      assert.match(top.stderr, /--as-user only creates an issue/u);

      const other = await runClient(['issue', 'view', '1', '--as-user', 'alice'], host.root);
      assert.equal(other.status, 1);
      assert.match(other.stderr, /--as-user only creates an issue/u);
    } finally {
      host.cleanup();
    }
  });

  it('refuses flags the host route does not carry', async () => {
    const host = fixture();
    try {
      const cases: [readonly string[], RegExp][] = [
        [['--repo', ''], /--repo needs a value/u],
        [['--proxy'], /--proxy needs a value/u],
        [['--proxy', 'http://p:1', '--no-proxy'], /mutually exclusive/u],
        [['--as-user', 'alice', '--as-user', 'bob'], /may only be given once/u],
        [['--label', 'x'], /unknown option --label/u],
      ];
      for (const [extra, expected] of cases) {
        const result = await runClient(
          ['issue', 'create', '--as-user', 'alice', '--title', 't', ...extra],
          host.root,
        );
        assert.equal(result.status, 1, extra.join(' '));
        assert.match(result.stderr, expected);
        assert.deepEqual(requests(host.dir), [], 'a refusal writes no request');
      }
    } finally {
      host.cleanup();
    }
  });
});
