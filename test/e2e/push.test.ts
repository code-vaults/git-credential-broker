/**
 * End-to-end proof.
 *
 * A real `git push` runs against a real `git http-backend` server that demands HTTP Basic
 * auth. The only thing supplying that credential is the shipped helper talking to the shipped
 * broker over a unix socket, with the broker's allowlist deciding.
 *
 * Two details of the harness are load-bearing:
 *  - the HTTP server lives in this process, so every git invocation is asynchronous; a
 *    `spawnSync` would block the event loop and deadlock the client waiting for that server;
 *  - every git and helper process runs with `http_proxy`/`https_proxy`/`all_proxy` pointing at
 *    a dead port and `NODE_USE_ENV_PROXY=1`, a faithful reproduction of this container. If any
 *    part of the credential path used HTTP instead of the socket, these tests would fail.
 *
 * Requires the compiled entry points, so run `yarn build` first (`yarn test` does).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createGitHttpServer } from '../lib/git-http-server.ts';
import type { GitHttpServer } from '../lib/git-http-server.ts';
import { runAsync, tryRunAsync, waitFor } from '../lib/run.ts';

/** The shipped artifacts, resolved next to this file rather than from the cwd. */
const HELPER_BIN = fileURLToPath(new URL('../../dist/cli/helper.js', import.meta.url));
const DAEMON_BIN = fileURLToPath(new URL('../../dist/cli/daemon.js', import.meta.url));

const USERNAME = 'x-access-token';
const PASSWORD = 'e2e-static-secret';
const REPO = 'acme/widget';
const OTHER = 'acme/other';
const EVIL = 'acme/widget-evil';

/** A port nothing listens on. */
const DEAD_PROXY = 'http://127.0.0.1:9';

/** A ready-to-use test environment. */
interface Harness {
  readonly root: string;
  readonly reposDir: string;
  readonly homeDir: string;
  readonly workDir: string;
  readonly socketPath: string;
  readonly auditPath: string;
  readonly host: string;
  readonly httpServer: GitHttpServer;
  readonly brokerLog: string[];
  gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  stopBroker(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Connect to a socket path once, to tell "file exists" from "listening".
 *
 * @param socketPath - the unix socket path.
 * @returns whether the connection succeeded.
 */
function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ path: socketPath });
    const done = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

/**
 * Read the audit log as records.
 *
 * @param auditPath - the JSONL path.
 * @returns the parsed records.
 */
function auditRecords(auditPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(auditPath)) return [];
  return fs
    .readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Build one isolated end-to-end environment.
 *
 * @param options - harness options.
 * @returns the harness.
 */
async function setupHarness(
  options: { allow?: readonly string[]; withBroker?: boolean; allowInsecureHttp?: boolean } = {},
): Promise<Harness> {
  const { allow = [REPO], withBroker = true, allowInsecureHttp = true } = options;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-e2e-'));
  const reposDir = path.join(root, 'repos');
  const homeDir = path.join(root, 'home');
  const workDir = path.join(root, 'work');
  for (const dir of [reposDir, homeDir, workDir]) fs.mkdirSync(dir, { recursive: true });

  for (const slug of [REPO, OTHER, EVIL]) {
    const dir = path.join(reposDir, `${slug}.git`);
    fs.mkdirSync(dir, { recursive: true });
    await runAsync('git', ['init', '--bare', '--initial-branch=main', dir]);
    await runAsync('git', ['-C', dir, 'config', 'http.receivepack', 'true']);
  }

  const httpServer = createGitHttpServer({ root: reposDir, username: USERNAME, password: PASSWORD });
  const port = await httpServer.listen();
  const host = `127.0.0.1:${port}`;

  const socketPath = path.join(root, 'broker', 'broker.sock');
  const auditPath = path.join(root, 'broker', 'audit.jsonl');
  const configPath = path.join(root, 'broker', 'config.json');
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        socketPath,
        auditPath,
        tokenCacheSkewSeconds: 5,
        hosts: {
          [host]: {
            provider: 'static',
            allow,
            // The local test server speaks plaintext http; the flag is the operator's
            // explicit opt-in, and it lives host-side where the agent cannot reach it.
            allowInsecureHttp,
            username: USERNAME,
            password: PASSWORD,
            expiresInSeconds: 3600,
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const brokerLog: string[] = [];
  let broker: ChildProcess | null = null;

  if (withBroker) {
    broker = spawn(process.execPath, [DAEMON_BIN, '--config', configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    broker.stdout?.on('data', (chunk: Buffer) => brokerLog.push(chunk.toString()));
    broker.stderr?.on('data', (chunk: Buffer) => brokerLog.push(chunk.toString()));
    await waitFor(() => canConnect(socketPath), { timeoutMs: 10_000, what: 'the broker to accept a connection' });
  }

  const stopBroker = async (): Promise<void> => {
    const target = broker;
    if (!target || target.exitCode !== null || target.signalCode !== null) {
      broker = null;
      return;
    }
    const exited = new Promise<void>((resolve) => target.once('exit', () => resolve()));
    target.kill('SIGTERM');
    const timer = setTimeout(() => target.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(timer);
    broker = null;
  };

  return {
    root,
    reposDir,
    homeDir,
    workDir,
    socketPath,
    auditPath,
    host,
    httpServer,
    brokerLog,
    gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
      return {
        ...process.env,
        // Isolate git from the developer's real configuration and credential store.
        HOME: homeDir,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'Broker Test',
        GIT_AUTHOR_EMAIL: 'broker@example.invalid',
        GIT_COMMITTER_NAME: 'Broker Test',
        GIT_COMMITTER_EMAIL: 'broker@example.invalid',
        // The broker channel.
        GIT_BROKER_SOCKET: socketPath,
        GIT_BROKER_REQUIRE: '1',
        // A hostile proxy environment: whatever cannot survive this is not socket-based.
        http_proxy: DEAD_PROXY,
        https_proxy: DEAD_PROXY,
        all_proxy: DEAD_PROXY,
        no_proxy: '127.0.0.1,localhost',
        NO_PROXY: '127.0.0.1,localhost',
        NODE_USE_ENV_PROXY: '1',
        ...extra,
      };
    },
    stopBroker,
    async dispose(): Promise<void> {
      await stopBroker();
      await httpServer.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Create a commit in the harness's work tree.
 *
 * @param harness - the harness.
 * @returns the commit SHA.
 */
async function seedCommit(harness: Harness): Promise<string> {
  const env = harness.gitEnv();
  await runAsync('git', ['init', '--initial-branch=main', harness.workDir], { env });
  fs.writeFileSync(path.join(harness.workDir, 'README.md'), '# pushed by the broker test\n');
  await runAsync('git', ['-C', harness.workDir, 'add', 'README.md'], { env });
  await runAsync('git', ['-C', harness.workDir, 'commit', '-m', 'initial commit'], { env });
  return (await runAsync('git', ['-C', harness.workDir, 'rev-parse', 'HEAD'], { env })).stdout.trim();
}

/**
 * Read a ref from a bare repository.
 *
 * @param harness - the harness.
 * @param slug - the repository slug.
 * @param ref - the ref name.
 * @returns the SHA.
 */
async function remoteRef(harness: Harness, slug: string, ref: string): Promise<string> {
  const env = harness.gitEnv();
  const result = await runAsync('git', ['-C', path.join(harness.reposDir, `${slug}.git`), 'rev-parse', ref], { env });
  return result.stdout.trim();
}

/**
 * Build the git arguments that wire in the shipped helper.
 *
 * @param extra - extra settings.
 * @returns the arguments.
 */
function withHelper(extra: readonly string[] = []): string[] {
  return ['-c', `credential.helper=${HELPER_BIN}`, '-c', 'credential.useHttpPath=true', ...extra];
}

describe('end-to-end push through the broker', () => {
  let harness: Harness;

  before(async () => {
    assert.equal(fs.existsSync(HELPER_BIN), true, `missing ${HELPER_BIN}; run \`yarn build\` first`);
    assert.equal(fs.existsSync(DAEMON_BIN), true, `missing ${DAEMON_BIN}; run \`yarn build\` first`);
    harness = await setupHarness();
  });

  after(async () => {
    await harness?.dispose();
  });

  it('authenticates a real git push and lands the commit', async () => {
    const expected = await seedCommit(harness);
    const pushed = await tryRunAsync(
      'git',
      ['-C', harness.workDir, ...withHelper(), 'push', `http://${harness.host}/${REPO}.git`, 'main'],
      { env: harness.gitEnv() },
    );
    assert.equal(pushed.status, 0, `push failed:\n--- stdout ---\n${pushed.stdout}\n--- stderr ---\n${pushed.stderr}`);

    assert.equal(await remoteRef(harness, REPO, 'refs/heads/main'), expected, 'the pushed commit must have landed');

    // The server really did challenge first: the credential arrived over 401 -> retry.
    assert.equal(
      harness.httpServer.attempts.some((attempt) => !attempt.authorized),
      true,
      'the server must have issued a 401 challenge first',
    );
    assert.equal(
      harness.httpServer.attempts.some((attempt) => attempt.authorized),
      true,
      'an authenticated request must have followed',
    );

    // Nothing was written to a credential store.
    assert.equal(fs.existsSync(path.join(harness.homeDir, '.git-credentials')), false);
  });

  it('records the grant in the audit log with a fingerprint instead of the secret', async () => {
    const records = await waitFor(
      () => {
        const found = auditRecords(harness.auditPath);
        return found.some((record) => record['decision'] === 'allow') ? found : null;
      },
      { timeoutMs: 5000, what: 'an allow record in the audit log' },
    );

    const first = records.filter((record) => record['decision'] === 'allow')[0];
    assert.ok(first);
    assert.equal(first['repo'], REPO);
    assert.equal(first['host'], harness.host);
    assert.equal(first['provider'], 'static');
    assert.match(String(first['token_fingerprint']), /^[0-9a-f]{12}$/);
    assert.equal(
      fs.readFileSync(harness.auditPath, 'utf8').includes(PASSWORD),
      false,
      'the credential must never appear in the audit log',
    );
  });

  it('refuses a fetch with no credentials at all, proving the server enforces auth', async () => {
    const anonymous = await tryRunAsync(
      'git',
      ['-c', 'credential.helper=', 'ls-remote', `http://${harness.host}/${REPO}.git`],
      { env: harness.gitEnv() },
    );
    assert.notEqual(anonymous.status, 0, 'an unauthenticated fetch must fail');
  });

  it('denies repositories that are not allowlisted, and never prefix-matches', async () => {
    const before = auditRecords(harness.auditPath).length;

    for (const slug of [OTHER, EVIL]) {
      // Both repositories exist on the server, so the only reason to fail is the policy.
      const attempt = await tryRunAsync('git', [...withHelper(), 'ls-remote', `http://${harness.host}/${slug}.git`], {
        env: harness.gitEnv(),
      });
      assert.notEqual(attempt.status, 0, `${slug} must not be reachable`);
    }

    const denials = await waitFor(
      () => {
        const found = auditRecords(harness.auditPath)
          .slice(before)
          .filter((record) => record['decision'] === 'deny');
        return found.length >= 2 ? found : null;
      },
      { timeoutMs: 5000, what: 'two deny records' },
    );

    assert.deepEqual(
      denials.map((record) => record['repo']).sort(),
      [EVIL, OTHER].sort(),
      'the sibling repository and the prefixed name must both be denied explicitly',
    );
    assert.equal(
      denials.every((record) => record['code'] === 'repo-not-allowed'),
      true,
    );
  });

  it('refuses a path-less credential request before ever contacting the broker', async () => {
    const before = auditRecords(harness.auditPath).length;
    const attempt = await tryRunAsync(
      'git',
      [
        '-c',
        `credential.helper=${HELPER_BIN}`,
        '-c',
        'credential.useHttpPath=false',
        'ls-remote',
        `http://${harness.host}/${REPO}.git`,
      ],
      { env: harness.gitEnv() },
    );

    assert.notEqual(attempt.status, 0, 'a host-wide credential must not be issued');
    assert.match(attempt.stderr, /useHttpPath/, 'the operator must be told which switch is missing');
    assert.equal(
      auditRecords(harness.auditPath).length,
      before,
      'the refusal happens in the helper, so the broker never sees the request',
    );
  });

  it('stops the helper chain instead of falling through to another helper', async () => {
    const decoyLog = path.join(harness.root, 'decoy.log');
    const decoy = path.join(harness.root, 'decoy-helper.sh');
    fs.writeFileSync(
      decoy,
      `#!/bin/sh\necho called >> ${JSON.stringify(decoyLog)}\nprintf 'username=decoy\\npassword=decoy\\n'\n`,
    );
    fs.chmodSync(decoy, 0o755);

    const description = 'protocol=https\nhost=github.com\npath=acme/widget.git\n\n';

    // (a) Configured but unreachable: quit=1 must stop the chain, so the decoy is never asked.
    const unreachable = harness.gitEnv({ GIT_BROKER_SOCKET: path.join(harness.root, 'missing.sock') });
    const refused = await tryRunAsync(
      'git',
      ['-c', `credential.helper=${HELPER_BIN}`, '-c', `credential.helper=${decoy}`, 'credential', 'fill'],
      { env: unreachable, input: description },
    );
    assert.notEqual(refused.status, 0, 'git must fail rather than fall through');
    assert.equal(fs.existsSync(decoyLog), false, 'the decoy helper must never be consulted');

    // (b) Unconfigured: the helper is invisible, so the host's own chain still works. This is
    // what keeps the bind-mounted repository config from breaking the human's own pushes.
    const unconfigured = harness.gitEnv();
    delete unconfigured['GIT_BROKER_SOCKET'];
    delete unconfigured['GIT_BROKER_REQUIRE'];
    const hostCase = await tryRunAsync(
      'git',
      ['-c', `credential.helper=${HELPER_BIN}`, '-c', `credential.helper=${decoy}`, 'credential', 'fill'],
      { env: unconfigured, input: description },
    );
    assert.equal(hostCase.status, 0, `the chain must continue:\n${hostCase.stderr}`);
    assert.match(hostCase.stdout, /username=decoy/, 'git must reach the next helper as if we were absent');
    assert.equal(fs.existsSync(decoyLog), true);
  });

  it('serves the credential over a unix socket, never through the proxy environment', async () => {
    const env = harness.gitEnv();
    assert.equal(env['http_proxy'], DEAD_PROXY, 'the test is only meaningful with a dead proxy configured');
    assert.equal(env['NODE_USE_ENV_PROXY'], '1');
    assert.equal(env['GIT_BROKER_SOCKET'], harness.socketPath, 'the credential channel is a filesystem path');

    const direct = await tryRunAsync(process.execPath, [HELPER_BIN, 'get'], {
      env,
      input: `protocol=https\nhost=${harness.host}\npath=${REPO}.git\n\n`,
    });
    assert.equal(direct.status, 0);
    assert.match(direct.stdout, /^username=x-access-token\npassword=.+\n$/);
  });
});

describe('end-to-end failure behaviour', () => {
  it('refuses a plaintext remote unless the host has opted in', async () => {
    const strict = await setupHarness({ allowInsecureHttp: false });
    try {
      const attempt = await tryRunAsync(
        'git',
        [...withHelper(), 'ls-remote', `http://${strict.host}/${REPO}.git`],
        { env: strict.gitEnv() },
      );
      assert.notEqual(attempt.status, 0, 'the default must be https-only');

      const denials = auditRecords(strict.auditPath).filter((record) => record['decision'] === 'deny');
      assert.equal(denials.length >= 1, true);
      assert.equal(denials[0]?.['code'], 'protocol-not-https');
    } finally {
      await strict.dispose();
    }
  });

  it('fails fast and closed when the broker is gone', async () => {
    const local = await setupHarness();
    try {
      const expected = await seedCommit(local);
      const ok = await tryRunAsync(
        'git',
        ['-C', local.workDir, ...withHelper(), 'push', `http://${local.host}/${REPO}.git`, 'main'],
        { env: local.gitEnv() },
      );
      assert.equal(ok.status, 0, `the warm-up push must succeed:\n${ok.stderr}`);
      assert.equal(await remoteRef(local, REPO, 'refs/heads/main'), expected);

      await local.stopBroker();

      const started = Date.now();
      const attempt = await tryRunAsync('git', [...withHelper(), 'ls-remote', `http://${local.host}/${REPO}.git`], {
        env: local.gitEnv(),
      });
      const elapsedMs = Date.now() - started;

      assert.notEqual(attempt.status, 0, 'a missing broker must not silently succeed');
      assert.match(attempt.stderr, /cannot reach the broker/, 'the failure must be diagnosable');
      assert.ok(elapsedMs < 10_000, `the failure must be fast, took ${elapsedMs}ms`);
    } finally {
      await local.dispose();
    }
  });
});
