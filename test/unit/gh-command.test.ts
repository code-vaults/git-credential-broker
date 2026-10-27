import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { startBroker } from '../../packages/host/src/broker.ts';
import { tryRunAsync, type RunResult } from '../lib/run.ts';
import type { AuditSink, BrokerConfig, Provider, StaticHostConfig } from '../../packages/cli/src/types.ts';

/** Run the client from source, next to this file rather than from the cwd. */
const CLIENT_BIN = fileURLToPath(new URL('../../packages/client/bin/gcb.js', import.meta.url));

/** Run the installed client as a child, so its output never replaces the test reporter. */
function runClient(args: readonly string[], cwd?: string): Promise<RunResult> {
  return tryRunAsync(
    process.execPath,
    ['--conditions=development', CLIENT_BIN, ...args],
    { cwd, env: process.env, timeoutMs: 5000 },
  );
}

function runGhCli(args: readonly string[], cwd?: string): Promise<RunResult> {
  return runClient(['gh', ...args], cwd);
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
      const result = await runGhCli(['pr', 'create', '--head', 'feat/x', '--title', 'x', '--body', 'b', '--repo', 'acme/widget', '--socket', socketPath]);
      assert.equal(result.status, 1);
      assert.ok(result.stdout.endsWith('partial output\n'));
      assert.match(result.stderr, /output was truncated/);
      assert.match(result.stderr, /may have completed/);
    } finally {
      await broker.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints a warning on a refused action', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-refused-warning-'));
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
        stdout: '',
        stderr: '',
        code: null,
        signal: null,
        truncated: false,
        timedOut: false,
        error: 'spawn failed',
        warning: 'the action token could not be revoked; it expires on its own',
      }),
    };
    const broker = await startBroker({ config, audit, providers: new Map([['github.com', provider]]) });
    try {
      const result = await runGhCli(['pr', 'view', '7', '-R', 'acme/widget', '--socket', socketPath]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /expires on its own/);
      assert.match(result.stderr, /refused/);
    } finally {
      await broker.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prints a provider warning to stderr', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-warning-'));
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
        stdout: 'viewed\n',
        stderr: '',
        code: 0,
        signal: null,
        truncated: false,
        timedOut: false,
        warning: 'the action token could not be revoked; it expires on its own',
      }),
    };
    const broker = await startBroker({ config, audit, providers: new Map([['github.com', provider]]) });
    try {
      const result = await runGhCli([
        'pr', 'view', '7', '--repo', 'acme/widget', '--socket', socketPath,
        '--proxy', 'http://proxy.example:7890',
      ]);
      assert.equal(result.status, 0);
      assert.match(result.stderr, /expires on its own/);
    } finally {
      await broker.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the repository from the checkout remote', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-remote-'));
    const checkout = path.join(root, 'checkout');
    fs.mkdirSync(checkout);
    execFileSync('git', ['init', '--quiet'], { cwd: checkout });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widget.git'], { cwd: checkout });
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
        assert.equal(request.full, 'acme/widget');
        return { stdout: 'ok\n', stderr: '', code: 0, signal: null, truncated: false, timedOut: false };
      },
    };
    const broker = await startBroker({ config, audit, providers: new Map([['github.com', provider]]) });
    try {
      const result = await runGhCli(['pr', 'view', '7', '--socket', socketPath], checkout);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, 'ok\n');
    } finally {
      await broker.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a remote URL that names more than owner/repo', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-remote-path-'));
    try {
      const checkout = path.join(root, 'checkout');
      fs.mkdirSync(checkout);
      execFileSync('git', ['init', '--quiet'], { cwd: checkout });
      execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/widget/issues'], { cwd: checkout });
      const result = await runGhCli(['pr', 'view', '7', '--socket', path.join(root, 'broker.sock')], checkout);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /no usable origin remote/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a checkout remote on another host', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-remote-host-'));
    try {
      const checkout = path.join(root, 'checkout');
      fs.mkdirSync(checkout);
      execFileSync('git', ['init', '--quiet'], { cwd: checkout });
      execFileSync('git', ['remote', 'add', 'origin', 'git@gitlab.com:acme/widget.git'], { cwd: checkout });
      const result = await runGhCli(['pr', 'view', '7', '--socket', path.join(root, 'broker.sock')], checkout);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /gitlab\.com/);
      assert.match(result.stderr, /--host/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes pr subcommands and run through the gh action', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-shorthand-'));
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
    const actions: string[] = [];
    const provider: Provider = {
      name: 'static',
      getCredential: async () => ({ username: 'u', password: 'p', expiresAt: Date.now() + 1000 }),
      runAction: async (request) => {
        actions.push(request.action);
        return { stdout: '', stderr: '', code: 0, signal: null, truncated: false, timedOut: false };
      },
    };
    const broker = await startBroker({ config, audit, providers: new Map([['github.com', provider]]) });
    try {
      const pr = await runClient(['pr', 'view', '7', '--repo', 'acme/widget', '--socket', socketPath]);
      assert.equal(pr.status, 0);
      const close = await runClient(['pr', 'close', '7', '--repo', 'acme/widget', '--socket', socketPath]);
      assert.equal(close.status, 0);
      const run = await runClient(['run', 'list', '--repo', 'acme/widget', '--socket', socketPath]);
      assert.equal(run.status, 0);
      assert.deepEqual(actions, ['pr:view', 'pr:close', 'run:list']);
    } finally {
      await broker.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not mistake a flag value for a help request', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-body-help-'));
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
    let seen: unknown;
    const provider: Provider = {
      name: 'static',
      getCredential: async () => ({ username: 'u', password: 'p', expiresAt: Date.now() + 1000 }),
      runAction: async (request) => {
        seen = request.values;
        return { stdout: '', stderr: '', code: 0, signal: null, truncated: false, timedOut: false };
      },
    };
    const broker = await startBroker({ config, audit, providers: new Map([['github.com', provider]]) });
    try {
      const result = await runGhCli([
        'pr', 'comment', '7', '--body', '--help', '--repo', 'acme/widget', '--socket', socketPath,
      ]);
      assert.equal(result.status, 0);
      assert.deepEqual(seen, { number: '7', body: '--help' });

      const shortHelp = await runGhCli([
        'pr', 'comment', '7', '--body', '-h', '--repo', 'acme/widget', '--socket', socketPath,
      ]);
      assert.equal(shortHelp.status, 0);
      assert.deepEqual(seen, { number: '7', body: '-h' }, 'a body of literally -h is data too');
    } finally {
      await broker.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats --help as help wherever it sits', async () => {
    // No broker is involved: each case has to answer before the socket is looked for.
    for (const argv of [
      ['--help'],
      ['pr', 'view', '--help', '7'],
      ['pr', 'view', '7', '--help'],
      ['pr', 'view', '7', '-h'],
      ['pr', 'create', '--title', '--head', '--help'],
      ['pr', 'create', '--title', '-h', '--head', 'feat', '--body', 'b'],
    ]) {
      const result = await runGhCli(argv);
      assert.equal(result.status, 0, argv.join(' '));
      assert.match(result.stdout, /Usage: gcb gh/);
    }
  });

  it('keeps the pr unreachable exit code', async () => {
    const result = await runClient(['pr', 'view', '7', '--repo', 'acme/widget', '--socket', '/nonexistent']);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /unreachable/);
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
    let seenProxy: string | null | undefined;
    const provider: Provider = {
      name: 'static',
      getCredential: async () => ({ username: 'u', password: 'p', expiresAt: Date.now() + 1000 }),
      runAction: async (request) => {
        assert.equal(request.action, 'pr:view');
        assert.deepEqual(request.values, { number: '7' });
        seenProxy = request.proxy;
        return { stdout: 'the viewed PR\n', stderr: '', code: 0, signal: null, truncated: false, timedOut: false };
      },
    };
    const broker = await startBroker({ config, audit, providers: new Map([['github.com', provider]]) });
    try {
      const result = await runGhCli([
        'pr', 'view', '7', '--repo', 'acme/widget', '--socket', socketPath,
        '--proxy', 'http://proxy.example:7890',
      ]);
      assert.equal(result.status, 0);
      assert.ok(result.stdout.endsWith('the viewed PR\n'));
      assert.equal(seenProxy, 'http://proxy.example:7890');
      const direct = await runGhCli([
        'pr', 'view', '7', '--repo', 'acme/widget', '--socket', socketPath, '--no-proxy',
      ]);
      assert.equal(direct.status, 0);
      assert.equal(seenProxy, null);
    } finally {
      await broker.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bare run', () => {
  it('prints the catalog help', async () => {
    const result = await runClient(['run']);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Usage: gcb gh/);
  });
});

describe('gh option values', () => {
  it('refuses an optional value flag followed by another flag', async () => {
    const result = await runGhCli([
      'pr', 'create', '--head', 'feat', '--title', 't', '--body', 'b', '--reviewer', '--draft',
      '--repo', 'acme/widget', '--socket', '/nonexistent',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--reviewer needs a value/);
  });

  it('refuses a value flag followed by another flag', async () => {
    const result = await runGhCli([
      'pr', 'create', '--head', 'feat', '--title', '--draft', '--body', 'b',
      '--repo', 'acme/widget', '--socket', '/nonexistent',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--title needs a value/);
  });
});

describe('help after a value flag', () => {
  it('prints help instead of a missing-value error', async () => {
    const result = await runGhCli([
      'pr', 'create', '--title', '--help', '--head', 'feat', '--body', 'b',
      '--repo', 'acme/widget', '--socket', '/nonexistent',
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: gcb gh/);
  });
});

describe('unknown gh options', () => {
  it('does not let an unknown flag become a value', async () => {
    const result = await runGhCli([
      'pr', 'comment', '7', '--body', 'x', '--bogus', 'y',
      '--repo', 'acme/widget', '--socket', '/nonexistent',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown option --bogus/);
  });
});

describe('short gh flags', () => {
  it('reports a missing -R value using the typed spelling', async () => {
    const result = await runGhCli(['pr', 'view', '7', '-R']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /-R needs a value/);
  });
});

describe('the -- terminator', () => {
  it('does not treat the token after -- as help', async () => {
    const result = await runGhCli([
      'pr', 'view', '7', '--repo', 'acme/widget', '--socket', '/nonexistent',
      '--', '--help',
    ]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /Usage: gcb gh/);
    assert.match(result.stderr, /too many positional arguments/);
  });
});
