import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { KILL_GRACE_MS, runGhAction } from '../../packages/host/src/gh.ts';

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

  it('refuses an issue-only action on a pull request', async () => {
    const gh = shim('if [ "$1" = "api" ]; then echo true; exit 0; fi; echo SHOULD_NOT_RUN');
    await assert.rejects(
      runGhAction({
        action: 'issue:close',
        values: { number: 7 },
        repo: 'acme/widget',
        token: 'app-token',
        ghPath: gh,
        env: { PATH: process.env.PATH },
      }),
      /pull request, not an issue/u,
    );
  });

  it('charges the issue-target probe to the action deadline', async () => {
    const gh = shim('sleep 2; if [ "$1" = "api" ]; then echo false; fi');
    const started = Date.now();
    const result = await runGhAction({
      action: 'issue:close',
      values: { number: 7 },
      repo: 'acme/widget',
      token: 'app-token',
      ghPath: gh,
      timeoutMs: 3_000,
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 4_500, 'the probe and action share one deadline');
  });

  it('refuses when the issue-target probe fails', async () => {
    const gh = shim('if [ "$1" = "api" ]; then echo boom >&2; exit 1; fi; echo SHOULD_NOT_RUN');
    await assert.rejects(
      runGhAction({
        action: 'issue:close',
        values: { number: 7 },
        repo: 'acme/widget',
        token: 'app-token',
        ghPath: gh,
        env: { PATH: process.env.PATH },
      }),
      /could not verify that #7 is an issue: boom/u,
    );
  });

  it('keeps bodies out of the process arguments', async () => {
    const gh = shim(
      'printf "ARGS=%s\n" "$*"; while [ "$#" -gt 0 ]; do if [ "$1" = "--body-file" ]; then printf "BODY="; cat "$2"; fi; shift; done',
    );
    for (const entry of [
      { action: 'issue:edit', values: { number: 7, body: 'secret edit' } },
      { action: 'issue:comment', values: { number: 7, body: 'secret comment' } },
      { action: 'pr:review', values: { number: 7, approve: true, body: 'secret review' } },
      { action: 'pr:comment', values: { number: 7, body: 'secret pr comment' } },
      { action: 'issue:create', values: { title: 't', body: 'secret issue' } },
      { action: 'pr:create', values: { head: 'feat/x', base: 'main', title: 't', body: 'secret pr' } },
    ]) {
      const result = await runGhAction({
        action: entry.action,
        values: entry.values,
        repo: 'acme/widget',
        token: 'app-token',
        ghPath: gh,
        env: { PATH: process.env.PATH },
      });
      assert.equal(result.code, 0, entry.action);
      assert.match(result.stdout, /BODY=secret/u);
      assert.doesNotMatch(result.stdout, /ARGS=.*secret/u, entry.action + ' body stays out of argv');
      assert.match(result.stdout, /--body-file/u);
    }
  });

  it('keeps the token out of the jq process environment', async () => {
    const gh = shim('printf "TOKEN=[%s]\nCONFIG=%s\n" "$GH_TOKEN" "$(cat "$GH_CONFIG_DIR/hosts.yml")"');
    const result = await runGhAction({
      action: 'pr:view',
      values: { number: 7, jq: '.body' },
      repo: 'acme/widget',
      token: 'app-token',
      host: 'GitHub.com',
      ghPath: gh,
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /TOKEN=\[\]/);
    assert.match(result.stdout, /github\.com:\n    oauth_token: app-token/);
  });

  it('SIGKILLs after the grace period when the process ignores SIGTERM', async () => {
    const timeoutMs = 2_000;
    const gh = shim('trap "" TERM; while :; do sleep 1; done');
    const started = Date.now();
    const result = await runGhAction({
      action: 'pr:view',
      values: { number: 1 },
      repo: 'acme/widget',
      token: 't',
      ghPath: gh,
      timeoutMs,
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.signal, 'SIGKILL');
    assert.ok(
      Date.now() - started >= timeoutMs + KILL_GRACE_MS - 300,
      'it waits out the SIGTERM grace period',
    );
  });

  it('SIGKILLs a descendant that outlives the parent', async () => {
    const timeoutMs = 2_000;
    const pidFile = path.join(os.tmpdir(), `gcb-child-${process.pid}-${Date.now()}.pid`);
    const gh = shim(
      `sh -c 'trap "" TERM; while :; do sleep 1; done' >/dev/null 2>&1 &\necho $! > ${JSON.stringify(pidFile)}\ntrap 'exit 0' TERM\nwait`,
    );
    let pid: number | undefined;
    try {
      const started = Date.now();
      const result = await runGhAction({
        action: 'pr:view',
        values: { number: 1 },
        repo: 'acme/widget',
        token: 't',
        ghPath: gh,
        timeoutMs,
        env: { PATH: process.env.PATH },
      });
      assert.equal(result.timedOut, true);
      assert.ok(
        Date.now() - started < timeoutMs + KILL_GRACE_MS / 2,
        'the parent closed before the grace, so the chase is what kills the descendant',
      );
      await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS + 500));
      const childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      pid = childPid;
      assert.throws(() => process.kill(childPid, 0), /ESRCH/, 'the descendant is gone');
    } finally {
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      fs.rmSync(pidFile, { force: true });
    }
  });

  it('SIGTERMs the process group first on timeout', async () => {
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
    assert.equal(result.signal, 'SIGTERM');
    assert.ok(Date.now() - started < 2000);
  });

  it('stops repeating the group kill once the group is gone', async () => {
    const gh = shim('sleep 5');
    const realKill = process.kill;
    const realChildKill = ChildProcess.prototype.kill;
    const kills: number[] = [];
    process.kill = ((pid: number, signal?: string | number) => {
      kills.push(Date.now());
      return realKill.call(process, pid, signal);
    }) as typeof process.kill;
    ChildProcess.prototype.kill = function (signal?: NodeJS.Signals | number): boolean {
      kills.push(Date.now());
      return realChildKill.call(this, signal);
    };
    try {
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
      const atResolve = kills.length;
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.ok(
        kills.length - atResolve <= 2,
        `kept killing: ${kills.length - atResolve} attempts in 400ms`,
      );
    } finally {
      process.kill = realKill;
      ChildProcess.prototype.kill = realChildKill;
    }
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

describe('runGhAction proxy override', { skip: onWindows }, () => {
  it('clears the proxy environment for a direct action', async () => {
    const gh = shim('printf "%s|%s|%s\\n" "$HTTP_PROXY" "$HTTPS_PROXY" "$NO_PROXY"');
    const result = await runGhAction({
      action: 'pr:view',
      values: { number: 7 },
      repo: 'acme/widget',
      token: 't',
      ghPath: gh,
      env: { PATH: process.env['PATH'] ?? '', HTTP_PROXY: 'http://old:1', NO_PROXY: 'old' },
      proxy: null,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), '||');
  });

  it('sets the proxy environment for an explicit action', async () => {
    const gh = shim('printf "%s|%s|%s\\n" "$HTTP_PROXY" "$HTTPS_PROXY" "$NO_PROXY"');
    const result = await runGhAction({
      action: 'pr:view',
      values: { number: 7 },
      repo: 'acme/widget',
      token: 't',
      ghPath: gh,
      env: { PATH: process.env['PATH'] ?? '' },
      proxy: 'http://proxy.example:7890',
    });
    assert.equal(result.code, 0);
    assert.equal(
      result.stdout.trim(),
      'http://proxy.example:7890|http://proxy.example:7890|localhost,127.0.0.1',
    );
  });
});
