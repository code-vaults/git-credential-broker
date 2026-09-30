/**
 * The daemon's start-up diagnostics.
 *
 * The case that motivated this file: a configuration written for the sidecar deployment, started
 * as a host process, used to report `ENOENT ... /etc/git-cred-broker/app.pem` and nothing else.
 * That path only exists inside the container, and the file the operator is staring at says nothing
 * about deployments, so the error has to say it for them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { after, describe, it } from 'node:test';

import { runDaemon } from '../../src/daemon.ts';

/** Scratch space for the file. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-daemon-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/**
 * A write stream that collects what the daemon reports.
 *
 * @returns the stream and its contents so far.
 */
function capture(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    } as unknown as Writable,
    text: () => chunks.join(''),
  };
}

/**
 * Write a configuration into its own directory.
 *
 * @param name - the directory to use.
 * @param config - the configuration object.
 * @returns the configuration file path.
 */
function writeConfig(name: string, config: unknown): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'broker.config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

/** A github-app host block, with the key path left to the caller. */
function githubAppHost(privateKeyPath: string) {
  return { provider: 'github-app', allow: ['a/one'], clientId: 'Iv1.x', appId: 1, privateKeyPath, permissions: { contents: 'write' } };
}

describe('daemon start-up diagnostics', () => {
  it('refuses native Windows instead of coming up with nothing enforced', async () => {
    // Before the config is even read: on Windows the socket would be a named pipe and the mode bits
    // would enforce nothing, so a broker that started would look healthy and be open to every local
    // process. No --config is passed here on purpose — the refusal must not depend on one.
    const err = capture();
    const code = await runDaemon(['--check'], {
      stderr: err.stream,
      stdout: capture().stream,
      platform: 'win32',
    });

    assert.equal(code, 1);
    assert.match(err.text(), /native Windows is not supported/);
    assert.match(err.text(), /WSL/, 'and points at the place that does work');
  });

  it('names the deployment mismatch instead of a bare ENOENT', async () => {
    const file = writeConfig('sidecar', {
      socketPath: '/run/git-broker/broker.sock',
      auditPath: '/var/log/git-cred-broker/audit.jsonl',
      hosts: { 'github.com': githubAppHost('/etc/git-cred-broker/app.pem') },
    });

    const err = capture();
    const code = await runDaemon(['--config', file, '--check'], { stderr: err.stream, stdout: capture().stream });

    assert.equal(code, 1);
    assert.match(err.text(), /exists only inside the sidecar container/);
    assert.match(err.text(), /init --mode host/, 'and says how to move to a host process');
  });

  it('points at the key when the layout matches how it is being run', async () => {
    const file = writeConfig('host', {
      socketPath: '/run/git-cred-broker/broker.sock',
      hosts: { 'github.com': githubAppHost(path.join(scratch, 'host', 'app.pem')) },
    });

    const err = capture();
    const code = await runDaemon(['--config', file, '--check'], { stderr: err.stream, stdout: capture().stream });

    assert.equal(code, 1);
    assert.match(err.text(), /is the host's path/);
    assert.match(err.text(), /--mode sidecar/, 'and mentions the other deployment, in case that was the intent');
  });

  it('--help prints the usage and exits 0', async () => {
    const out = capture();
    assert.equal(await runDaemon(['--help'], { stdout: out.stream, stderr: capture().stream }), 0);
    assert.match(out.text(), /GIT_BROKER_CONFIG/);
  });
});
