import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const HOST_BIN = fileURLToPath(new URL('../../packages/host/bin/gcb.js', import.meta.url));

function config(socketPath: string, allow: readonly string[], auditPath: string): string {
  const entries = allow.map((entry) => `      - ${entry}`).join('\n');
  return `socketPath: ${socketPath}\nauditPath: ${auditPath}\nhosts:\n  github.com:\n    provider: static\n    username: x-access-token\n    password: secret\n    allow:\n${entries}\n`;
}

function request(socketPath: string, message: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let text = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('broker did not answer'));
    }, 1_000);
    timer.unref();
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8');
      const newline = text.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(JSON.parse(text.slice(0, newline)) as Record<string, unknown>);
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.write(JSON.stringify(message) + '\n');
  });
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch {
      // Not ready yet.
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('timed out');
}

describe('daemon live reload', () => {
  it('swaps a valid allowlist, keeps the last good one on failure, and refuses a socket change', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-daemon-reload-'));
    const socketPath = path.join(root, 'broker.sock');
    const file = path.join(root, 'broker.config.yml');
    const auditPath = path.join(root, 'audit.jsonl');
    fs.writeFileSync(file, config(socketPath, ['acme/one'], auditPath));
    const child = spawn(
      process.execPath,
      ['--conditions=development', HOST_BIN, 'daemon', '--config', file],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_USE_ENV_PROXY: '1',
          no_proxy: 'localhost,127.0.0.1',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let log = '';
    child.stderr.on('data', (chunk: Buffer) => { log += chunk.toString('utf8'); });
    try {
      await waitFor(async () => {
        const answer = await request(socketPath, {
          op: 'credential', host: 'github.com', path: 'acme/one', protocol: 'https',
        });
        return answer['ok'] === true ? answer : undefined;
      });

      fs.writeFileSync(file, config(socketPath, ['acme/two'], auditPath));
      await waitFor(async () => {
        const answer = await request(socketPath, {
          op: 'credential', host: 'github.com', path: 'acme/two', protocol: 'https',
        });
        return answer['ok'] === true ? answer : undefined;
      });

      fs.writeFileSync(file, 'hosts: [\n');
      const auditHasFailed = async (): Promise<true | undefined> =>
        fs.existsSync(auditPath) && fs.readFileSync(auditPath, 'utf8').includes('"decision":"reload-failed"')
          ? true
          : undefined;
      await waitFor(auditHasFailed);
      assert.match(fs.readFileSync(auditPath, 'utf8'), /"event":"config".*"decision":"reload-failed"/u);
      const kept = await request(socketPath, {
        op: 'credential', host: 'github.com', path: 'acme/two', protocol: 'https',
      });
      assert.equal(kept['ok'], true, 'the last good allowlist still serves');

      fs.writeFileSync(file, config(`${socketPath}.other`, ['acme/two'], auditPath));
      child.kill('SIGHUP');
      await waitFor(async () => (log.includes('socketPath cannot change') ? true : undefined));
      const stillOld = await request(socketPath, {
        op: 'credential', host: 'github.com', path: 'acme/two', protocol: 'https',
      });
      assert.equal(stillOld['ok'], true, 'the old socket path keeps serving');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
