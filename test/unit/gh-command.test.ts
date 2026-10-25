import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runGh } from '../../packages/client/src/commands/gh.ts';
import { startBroker } from '../../packages/host/src/broker.ts';
import type { AuditSink, BrokerConfig, Provider, StaticHostConfig } from '../../packages/cli/src/types.ts';

/** Capture stdout for one command. */
async function capture(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { code: await run(), stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

describe('gcb gh', () => {
  it('reports truncation and timed-out writes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-output-'));
    const socketPath = path.join(root, 'broker.sock');
    const block: StaticHostConfig = { provider: 'static', allow: ['acme/widget'] };
    const config: BrokerConfig = {
      socketPath,
      socketMode: 0o600,
      auditPath: null,
      tokenCacheSkewSeconds: 300,
      hosts: { 'github.com': block },
    };
    const audit: AuditSink = { path: null, record: () => {}, close: () => Promise.resolve() };
    const provider: Provider = {
      name: 'static',
      getCredential: async () => ({ username: 'u', password: 'p', expiresAt: Date.now() + 1000 }),
      runAction: async () => ({
        stdout: 'partial output\n',
        stderr: '',
        code: 0,
        signal: null,
        truncated: true,
        timedOut: true,
      }),
    };
    const broker = await startBroker({ config, audit, providers: new Map([['github.com', provider]]) });
    try {
      const result = await capture(() =>
        runGh(['pr', 'create', '--head', 'feat/x', '--title', 'x', '--body', 'b', '--repo', 'acme/widget', '--socket', socketPath]),
      );
      assert.equal(result.code, 1);
      assert.ok(result.stdout.endsWith('partial output\n'));
      assert.match(result.stderr, /output was truncated/);
      assert.match(result.stderr, /may have completed/);
    } finally {
      await broker.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sends a typed action to the broker and prints its stdout', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-command-'));
    const socketPath = path.join(root, 'broker.sock');
    const block: StaticHostConfig = { provider: 'static', allow: ['acme/widget'] };
    const config: BrokerConfig = {
      socketPath,
      socketMode: 0o600,
      auditPath: null,
      tokenCacheSkewSeconds: 300,
      hosts: { 'github.com': block },
    };
    const audit: AuditSink = { path: null, record: () => {}, close: () => Promise.resolve() };
    const provider: Provider = {
      name: 'static',
      getCredential: async () => ({ username: 'u', password: 'p', expiresAt: Date.now() + 1000 }),
      runAction: async (request) => {
        assert.equal(request.action, 'pr:view');
        assert.deepEqual(request.values, { number: '7' });
        return { stdout: 'the viewed PR\n', stderr: '', code: 0, signal: null, truncated: false, timedOut: false };
      },
    };
    const broker = await startBroker({ config, audit, providers: new Map([['github.com', provider]]) });
    try {
      const result = await capture(() =>
        runGh(['pr', 'view', '7', '--repo', 'acme/widget', '--socket', socketPath]),
      );
      assert.equal(result.code, 0);
      assert.ok(result.stdout.endsWith('the viewed PR\n'));
    } finally {
      await broker.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
