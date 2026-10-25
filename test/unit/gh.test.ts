import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runGhAction } from '../../packages/host/src/gh.ts';

const onWindows = process.platform === 'win32';

/** Write an executable sh shim and return its path. */
function shim(body: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-test-'));
  const file = path.join(root, 'gh');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

describe('runGhAction', { skip: onWindows }, () => {
  it('runs the canonical argv with the app token and an isolated home', async () => {
    const gh = shim('printf "TOKEN=%s\\nHOME=%s\\nCONFIG=%s\\nARGS=%s\\n" "$GH_TOKEN" "$HOME" "$GH_CONFIG_DIR" "$*"');
    const hostHome = path.join(os.tmpdir(), 'host-home-not-used');
    const result = await runGhAction({
      action: 'pr:view',
      values: { number: 7 },
      repo: 'acme/widget',
      token: 'app-token',
      ghPath: gh,
      env: { PATH: process.env.PATH, HOME: hostHome, GH_TOKEN: 'host-token' },
    });
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
    assert.match(result.stdout, /TOKEN=app-token/);
    assert.match(result.stdout, /ARGS=pr view 7 --repo acme\/widget/);
    assert.doesNotMatch(result.stdout, /host-home-not-used/);
    assert.doesNotMatch(result.stdout, /host-token/);
  });

  it('kills the process group on timeout', async () => {
    const gh = shim('sleep 5');
    const started = Date.now();
    const result = await runGhAction({
      action: 'pr:view',
      values: { number: 1 },
      repo: 'acme/widget',
      token: 't',
      ghPath: gh,
      timeoutMs: 50,
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 2000);
  });

  it('caps output and reports truncation', async () => {
    const gh = shim('printf "0123456789"');
    const result = await runGhAction({
      action: 'pr:view',
      values: { number: 1 },
      repo: 'acme/widget',
      token: 't',
      ghPath: gh,
      maxOutputBytes: 4,
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(result.stdout) <= 4);
  });

  it('reports a missing gh executable', async () => {
    const result = await runGhAction({
      action: 'pr:view',
      values: { number: 1 },
      repo: 'acme/widget',
      token: 't',
      ghPath: path.join(os.tmpdir(), 'gcb-no-such-gh'),
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.code, null);
    assert.match(result.error ?? '', /ENOENT/);
  });
});

describe('runGhAction stream boundaries', { skip: onWindows }, () => {
  it('decodes a UTF-8 character split across pipe reads', async () => {
    const gh = shim("printf '\\360\\237'; sleep 0.05; printf '\\230\\200'");
    const result = await runGhAction({
      action: 'pr:view',
      values: { number: 1 },
      repo: 'acme/widget',
      token: 't',
      ghPath: gh,
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.stdout, '😀');
    assert.equal(result.truncated, false);
  });

  it('keeps signalling the group when a forked child holds stdout', async () => {
    for (let run = 0; run < 4; run++) {
      const gh = shim('dd if=/dev/zero bs=1 count=8 2>/dev/null; sleep 30 &');
      const started = Date.now();
      const result = await runGhAction({
        action: 'pr:view',
        values: { number: 1 },
        repo: 'acme/widget',
        token: 't',
        ghPath: gh,
        maxOutputBytes: 4,
        timeoutMs: 5000,
        env: { PATH: process.env.PATH },
      });
      assert.equal(result.truncated, true);
      assert.ok(Date.now() - started < 2000, `run ${run} took too long`);
    }
  });
});
