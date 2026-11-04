import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { startBroker } from '../../packages/host/src/broker.ts';
import { channelDir, listRequests, readRequest, writeHostBroker, writeResult } from '../../packages/core/src/host-request.ts';
import { tryRunAsync, type RunResult } from '../common/run.ts';
import type { AuditSink, BrokerConfig, Provider, StaticHostConfig } from '../../packages/core/src/types.ts';

/** Run the client from source, next to this file rather than from the cwd. */
const CLIENT_BIN = fileURLToPath(new URL('../../packages/client/bin/gcb.js', import.meta.url));

/** Run the installed client as a child, so its output never replaces the test reporter. */
function runClient(args: readonly string[], cwd?: string, input?: string): Promise<RunResult> {
  return tryRunAsync(
    process.execPath,
    ['--conditions=development', CLIENT_BIN, ...args],
    { cwd, env: process.env, input, timeoutMs: 5000 },
  );
}

function runGhCli(args: readonly string[], cwd?: string, input?: string): Promise<RunResult> {
  return runClient(['gh', ...args], cwd, input);
}

/** Run the client while keeping stdin open; an ordering bug then hangs instead of reading EOF. */
function runClientWithOpenStdin(args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--conditions=development', CLIENT_BIN, ...args], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, 2_000);
    function finish(status: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout, stderr, error: null });
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', () => finish(null));
    child.on('close', (status) => finish(status));
  });
}

describe('gcb gh', () => {
  it('reports an unreadable body file', async () => {
    const result = await runGhCli([
      'issue',
      'comment',
      '7',
      '--body-file',
      '/definitely/not/here',
      '--repo',
      'acme/widget',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot read \/definitely\/not\/here/u);
  });

  it('routes issue through the same catalog checks', async () => {
    const unknown = await runClient(['issue', '--bogus']);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown gh action "issue:--bogus"/u);

    const missing = await runClient(['issue', 'create', '--title']);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /--title needs a value/u);

    const action = await runClient(['issue', 'view', '7', '--repo', 'acme/widget']);
    assert.equal(action.status, 1);
    assert.match(action.stderr, /unknown gh action "issue:view"/u);

    const unconfigured = await runClient(['issue', 'create', '--title', 't', '--body', 'b', '--repo', 'acme/widget']);
    assert.equal(unconfigured.status, 1);
    assert.match(unconfigured.stderr, /error: /u);
    assert.doesNotMatch(unconfigured.stderr, /unknown gh action|needs --title/u);
  });

  it('refuses a repository option with no parsed value', async () => {
    for (const flag of ['--repo', '--R']) {
      const result = await runClient(['gh', 'pr', 'close', '7', flag, '--']);
      assert.equal(result.status, 1, flag);
      assert.match(result.stderr, /--repo needs a value; refusing to fall back to the checkout/u);
    }
  });

  it('does not read a post-terminator --as-user as identity', async () => {
    const result = await runClient([
      'gh',
      'pr',
      'close',
      '7',
      '--repo',
      'acme/widget',
      '--socket',
      '/definitely/not/here.sock',
      '--',
      '--as-user',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /too many positional/u);
  });

  it('rejects a missing title before --as-user', async () => {
    const result = await runClient([
      'gh',
      'pr',
      'edit',
      '1',
      '--title',
      '--as-user',
      '--body',
      'b',
      '--repo',
      'acme/widget',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--title needs a value/u);
  });

  it('does not read -as-user as identity when it is a value', async () => {
    const result = await runClient([
      'gh',
      'pr',
      'edit',
      '1',
      '--title',
      '-as-user',
      '--repo',
      'acme/widget',
      '--socket',
      '/definitely/not/here.sock',
    ]);
    assert.doesNotMatch(result.stderr, /--as-user/u);
    assert.match(result.stderr, /unreachable|cannot reach/u);
  });

  it('does not read -R as a repository option when it is body data', async () => {
    const result = await runClient([
      'gh',
      'issue',
      'comment',
      '7',
      '--body',
      '-R',
      '--socket',
      '/definitely/not/here.sock',
    ]);
    assert.doesNotMatch(result.stderr, /--repo needs a value/u);
    assert.match(result.stderr, /unreachable|cannot reach|--repo is required/u);
  });

  it('shows help before refusing an unsupported identity', async () => {
    const result = await runClient(['gh', 'pr', 'view', '--as-user', '--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: gcb gh/u);
  });

  it('shows help when -as-user is body data', async () => {
    const result = await runClient(['gh', 'issue', 'comment', '7', '--body', '-as-user', '--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: gcb gh/u);

    const duplicate = await runClient(['gh', 'pr', 'view', '1', '--as-user', '--as-user', '--help']);
    assert.equal(duplicate.status, 0);
    assert.match(duplicate.stdout, /Usage: gcb gh/u);
  });

  it('rejects --socket on the login route before reading stdin', async () => {
    const result = await runClientWithOpenStdin([
      'gh',
      'issue',
      'comment',
      '7',
      '--body-file',
      '-',
      '--as-user',
      'alice',
      '--repo',
      'acme/widget',
      '--socket',
      '/definitely/not/here.sock',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--socket is the app broker route/u);
  });

  it('rejects built-in pr review conflicts before reading stdin', async () => {
    const result = await runClientWithOpenStdin([
      'pr',
      '--approve',
      '--request-changes',
      '--body-file',
      '-',
      '--number',
      '7',
      '--repo',
      'acme/widget',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exactly one of/u);
  });

  it('rejects an invalid login before reading stdin', async () => {
    const result = await runClientWithOpenStdin([
      'gh',
      'issue',
      'comment',
      '7',
      '--body-file',
      '-',
      '--as-user',
      'not a login',
      '--repo',
      'acme/widget',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--as-user must be a GitHub login/u);
  });

  it('rejects review conflicts before reading stdin', async () => {
    const result = await runClientWithOpenStdin([
      'gh',
      'pr',
      'review',
      '1',
      '--approve',
      '--request-changes',
      '--body-file',
      '-',
      '--repo',
      'acme/widget',
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exactly one of/u);
  });

  it('rejects an empty resolve id before reading stdin', async () => {
    const result = await runClientWithOpenStdin(['pr', '--resolve=', '--body-file', '-', '--repo', 'acme/widget']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--resolve needs/u);
  });

  it('refuses --body together with --body-file', async () => {
    const result = await runGhCli(['pr', 'comment', '7', '--body', 'x', '--body-file', 'f', '--repo', 'acme/widget']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--body and --body-file are mutually exclusive/u);
  });

  it('accepts bare --as-user for an appUser action', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-as-user-'));
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
    let identity: string | undefined;
    const provider: Provider = {
      name: 'static',
      getCredential: async () => ({ username: 'u', password: 'p', expiresAt: Date.now() + 1000 }),
      runAction: async (request) => {
        identity = request.identity;
        return { stdout: '', stderr: '', code: 0, signal: null, truncated: false, timedOut: false };
      },
    };
    const broker = await startBroker({ config, audit, providers: new Map([['github.com', provider]]) });
    try {
      const result = await runGhCli([
        'issue',
        'comment',
        '7',
        '--body',
        'x',
        '--as-user',
        '--repo',
        'acme/widget',
        '--socket',
        socketPath,
      ]);
      assert.equal(result.status, 0);
      assert.equal(identity, 'user');
    } finally {
      await broker.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('times out a claimed action without reporting it lost', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-claim-'));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const dir = channelDir(path.join(root, '.git'));
    writeHostBroker(dir, { pid: process.pid, kinds: ['action'] });
    try {
      const pending = tryRunAsync(
        process.execPath,
        [
          '--conditions=development',
          CLIENT_BIN,
          'issue',
          'comment',
          '7',
          '--body',
          'x',
          '--as-user',
          'alice',
          '--repo',
          'acme/widget',
        ],
        {
          cwd: root,
          env: { ...process.env, GCB_HOST_TIMEOUT_MS: '1000' },
          timeoutMs: 5_000,
        },
      );
      let claimed = false;
      for (let attempt = 0; attempt < 200 && !claimed; attempt += 1) {
        const [id] = listRequests(dir);
        if (id !== undefined) {
          fs.renameSync(path.join(dir, `${id}.json`), path.join(dir, `${id}.json.working`));
          claimed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(claimed, true);
      const result = await pending;
      assert.equal(result.status, 1);
      assert.match(result.stderr, /did not answer/u);
      assert.match(result.stderr, /within 1s/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs a login action through the host broker', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-host-action-'));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const dir = channelDir(path.join(root, '.git'));
    writeHostBroker(dir, { pid: process.pid, kinds: ['action'] });
    try {
      const pending = runGhCli(
        ['issue', 'comment', '7', '--body', 'x', '--as-user', 'alice', '--repo', 'acme/widget'],
        root,
      );
      let id: string | undefined;
      let request;
      for (let attempt = 0; attempt < 100 && request === undefined; attempt += 1) {
        [id] = listRequests(dir);
        request = id === undefined ? undefined : readRequest(dir, id);
        if (request === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(request, 'the action reached the host broker');
      assert.equal(request?.kind, 'action');
      assert.equal(request?.kind === 'action' ? request.action : undefined, 'issue:comment');
      assert.equal(request?.account, 'alice');
      writeResult(dir, id as string, { stdout: 'ok\n', stderr: '', code: 0 });
      const result = await pending;
      assert.equal(result.status, 0);
      assert.equal(result.stdout, 'ok\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses the login form and appUser-less actions', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-login-'));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const login = await runGhCli(
      ['issue', 'comment', '7', '--body', 'x', '--as-user', 'alice', '--repo', 'acme/widget'],
      root,
    );
    fs.rmSync(root, { recursive: true, force: true });
    assert.equal(login.status, 1);
    assert.match(login.stderr, /no host broker is watching/u);

    const unsupported = await runGhCli(['pr', 'create', '--head', 'h', '--title', 't', '--body', 'b', '--as-user', '--repo', 'acme/widget']);
    assert.equal(unsupported.status, 1);
    assert.match(unsupported.stderr, /does not support --as-user/u);
  });

  it('reads --body-file - from stdin', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-gh-stdin-'));
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
    let seen: Record<string, unknown> = {};
    const provider: Provider = {
      name: 'static',
      getCredential: async () => ({ username: 'u', password: 'p', expiresAt: Date.now() + 1000 }),
      runAction: async (request) => {
        seen = { ...request.values };
        return { stdout: '', stderr: '', code: 0, signal: null, truncated: false, timedOut: false };
      },
    };
    const broker = await startBroker({ config, audit, providers: new Map([['github.com', provider]]) });
    try {
      const result = await runGhCli(
        ['pr', 'comment', '7', '--body-file', '-', '--repo', 'acme/widget', '--socket', socketPath],
        undefined,
        'from stdin\n',
      );
      assert.equal(result.status, 0);
      assert.equal(seen['body'], 'from stdin\n');
    } finally {
      await broker.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

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

  it('routes pr, run and issue subcommands through the gh action', async () => {
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
      const issue = await runClient([
        'issue', 'create', '--repo', 'acme/widget', '--title', 't', '--body', 'b', '--socket', socketPath,
      ]);
      assert.equal(issue.status, 0);
      assert.deepEqual(actions, ['pr:view', 'pr:close', 'run:list', 'issue:create']);
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

describe('the help path', () => {
  it('routes gcb help gh pr to gh pr --help', async () => {
    const result = await runClient(['help', 'gh', 'pr']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: gcb gh/);
  });
});

describe('a help path that is the help command', () => {
  it('prints root help for help --help and help help', async () => {
    for (const args of [['help', '--help'], ['help', 'help']]) {
      const result = await runClient(args);
      assert.equal(result.status, 0, args.join(' '));
      assert.match(result.stdout, /Usage: gcb/);
    }
  });
});

describe('an invalid help path', () => {
  it('does not run a command when the path contains options', async () => {
    for (const args of [
      ['help', 'pr', '--'],
      ['help', 'pr', '--number'],
      ['help', 'pr', '--help'],
    ]) {
      const result = await runClient(args);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, /help takes a command path/);
    }
  });
});

describe('command-specific help refusal', () => {
  it('runs the dispatcher checks for help host', async () => {
    const result = await runClient(['help', 'host']);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    if (process.platform === 'win32') {
      assert.match(result.stderr, /native Windows is not supported/);
    } else {
      assert.match(result.stderr, /`host` is a host command; install gcb-host on the host/);
    }
  });
});
