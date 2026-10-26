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

describe('runGhAction decoded output cap', { skip: onWindows }, () => {
  it('keeps decoded text within the byte budget when invalid bytes expand', async () => {
    const gh = shim("printf '\\377%.0s' $(seq 1 4)");
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
});

describe('runGhAction options', { skip: onWindows }, () => {
  it('rejects an invalid output ceiling before creating anything', async () => {
    for (const maxOutputBytes of [Number.POSITIVE_INFINITY, Number.NaN, -1, 1.5]) {
      await assert.rejects(
        runGhAction({
          action: 'pr:view',
          values: { number: 1 },
          repo: 'acme/widget',
          token: 't',
          maxOutputBytes,
          env: { PATH: process.env.PATH },
        }),
        /non-negative safe integer/,
      );
    }
  });
});

describe('runGhAction orphan cleanup', { skip: onWindows }, () => {
  it('kills a forked child after the parent closes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-orphan-'));
    const pidFile = path.join(dir, 'child.pid');
    const gh = shim(
      [
        '( exec >/dev/null 2>&1; sleep 5 ) &',
        'echo $! > "$GH_TOKEN"',
        'trap "exit 0" TERM',
        'sleep 5',
      ].join('\n'),
    );
    try {
      const result = await runGhAction({
        action: 'pr:view',
        values: { number: 1 },
        repo: 'acme/widget',
        token: pidFile,
        ghPath: gh,
        timeoutMs: 100,
        env: { PATH: process.env.PATH },
      });
      assert.equal(result.timedOut, true);
      let pid = 0;
      for (let i = 0; i < 20 && pid === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (fs.existsSync(pidFile)) pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      }
      assert.ok(pid > 0, 'the orphan wrote its pid');
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
