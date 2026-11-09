import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, it } from 'node:test';

import { channelDir, readResult, writeRequest } from '../../packages/core/src/host-request.ts';
import { runHostBroker } from '../../packages/host/src/commands/host.ts';

let statusFile = '';
let previousStatusPath: string | undefined;
before(() => {
  statusFile = join(tmpdir(), `host-fork-status-${String(process.pid)}.json`);
  previousStatusPath = process.env['GCB_HOST_STATUS'];
  process.env['GCB_HOST_STATUS'] = statusFile;
});
after(() => {
  rmSync(statusFile, { force: true });
  if (previousStatusPath === undefined) delete process.env['GCB_HOST_STATUS'];
  else process.env['GCB_HOST_STATUS'] = previousStatusPath;
});

it('runs an action on the parent of an allowlisted fork', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-broker-fork-'));
  const repo = join(root, 'checkout');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  const config = join(root, 'broker.config.yml');
  writeFileSync(
    config,
    `socketPath: ${join(root, 'broker.sock')}\nhosts:\n  ghe.example:\n    provider: github-app\n    clientId: Iv1.clientid\n    privateKeyPem: x\n    allowFork: true\n    allow:\n      - alice/widget\n`,
    'utf8',
  );
  const dir = channelDir(join(repo, '.git'));
  const command = join(root, 'not-gh');
  writeFileSync(command, '#!/bin/sh\necho "fork action"\n', 'utf8');
  chmodSync(command, 0o755);
  const originalFetch = globalThis.fetch;
  let requested = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(JSON.stringify({ fork: true, parent: { full_name: 'Acme/Widget' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const id = writeRequest(dir, {
      kind: 'action',
      action: 'issue:create',
      repo: 'acme/widget',
      host: 'ghe.example',
      values: { title: 't', body: 'b' },
    });
    assert.equal(await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']), 0);
    assert.equal(readResult(dir, id)?.stdout, 'fork action\n');
    assert.match(requested, /\/repos\/alice\/widget$/u);
    assert.equal(existsSync(join(repo, '.git', 'gcb', 'host-broker', `${id}.json`)), false);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
