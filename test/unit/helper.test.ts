/**
 * Tests for the container-side helper.
 *
 * The important ones are the two opposite behaviours around an unconfigured helper, because
 * repository configuration is shared with the host through the bind mount:
 *  - unconfigured                  -> behave as if not installed (the host's own chain still works);
 *  - configured but unreachable    -> refuse with `quit=1` (nothing silently falls through).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { after, describe, it } from 'node:test';

import { parseArgs, parseCredentialInput, runHelper } from '../../src/helper.ts';
import type { WireResponse } from '../../src/types.ts';

const CLIENT_REQUEST = 'protocol=https\nhost=github.com\npath=acme/widget.git\n\n';

/** Temp dir for the fake broker sockets. */
const tempDir = mkdtempSync(path.join(tmpdir(), 'gcb-helper-'));
after(() => rmSync(tempDir, { recursive: true, force: true }));

/** Captured streams plus their text. */
interface Capture {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  stdoutText(): string;
  stderrText(): string;
}

/**
 * Capture the helper's streams.
 *
 * @param input - what git would write to stdin.
 * @returns the streams plus accessors for what was written.
 */
function capture(input: string): Capture {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdin: Readable.from([input]),
    stdout: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        out.push(chunk.toString());
        callback();
      },
    }),
    stderr: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        err.push(chunk.toString());
        callback();
      },
    }),
    stdoutText: () => out.join(''),
    stderrText: () => err.join(''),
  };
}

/**
 * Run the helper against a canned broker response served over a real socket.
 *
 * @param response - the JSON the fake broker replies with.
 * @returns the fake broker; always close it.
 */
async function startFakeBroker(response: WireResponse): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const socketPath = path.join(tempDir, `broker-${Math.random().toString(36).slice(2)}.sock`);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', () => socket.write(`${JSON.stringify(response)}\n`));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        // Destroy first: `server.close` waits for open connections, and a failed assertion
        // must not leave a listening handle behind (that would hang the whole test run).
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe('parseCredentialInput', () => {
  it('reads git key=value lines and ignores trailing blanks', () => {
    assert.deepEqual(parseCredentialInput(CLIENT_REQUEST), {
      protocol: 'https',
      host: 'github.com',
      path: 'acme/widget.git',
    });
  });

  it('keeps values containing equals signs intact', () => {
    assert.equal(parseCredentialInput('url=https://example.com/a=b\n')['url'], 'https://example.com/a=b');
  });
});

describe('parseArgs', () => {
  it('defaults to get and accepts an explicit socket', () => {
    assert.deepEqual(parseArgs([]), { operation: 'get', socketPath: undefined, strict: false });
    assert.equal(parseArgs(['get', '--socket', '/tmp/x.sock']).socketPath, '/tmp/x.sock');
    assert.equal(parseArgs(['--socket=/tmp/x.sock', 'store']).operation, 'store');
    assert.equal(parseArgs(['get', '--strict']).strict, true);
  });
});

describe('runHelper: not configured means invisible', () => {
  it('is a silent no-op so the host\u2019s own helper chain still runs', async () => {
    const io = capture(CLIENT_REQUEST);
    const code = await runHelper(['get'], { ...io, env: {} });
    assert.equal(code, 0);
    assert.equal(io.stdoutText(), '', 'must print nothing at all, not even quit=1');
    assert.equal(io.stderrText(), '', 'must not be noisy in the host\u2019s terminal');
  });

  it('still refuses when GIT_BROKER_REQUIRE=1 asks for strictness', async () => {
    const io = capture(CLIENT_REQUEST);
    const code = await runHelper(['get', '--strict'], { ...io, env: {} });
    assert.equal(code, 0);
    assert.equal(io.stdoutText(), 'quit=1\n');
    assert.match(io.stderrText(), /GIT_BROKER_SOCKET is not set/);
  });
});

describe('runHelper: configured means fail-closed', () => {
  it('never persists anything for store or erase', async () => {
    for (const operation of ['store', 'erase']) {
      const io = capture('protocol=https\nhost=github.com\nusername=u\npassword=p\n');
      const code = await runHelper([operation], { ...io, env: { GIT_BROKER_SOCKET: '/nonexistent' } });
      assert.equal(code, 0);
      assert.equal(io.stdoutText(), '');
    }
  });

  it('refuses a protocol it cannot reason about', async () => {
    const io = capture('protocol=ftp\nhost=github.com\npath=acme/widget.git\n');
    await runHelper(['get'], { ...io, env: { GIT_BROKER_SOCKET: '/nonexistent' } });
    assert.equal(io.stdoutText(), 'quit=1\n');
    assert.match(io.stderrText(), /only http and https are understood/);
  });

  it('forwards plaintext http and lets the broker make the protocol decision', async () => {
    // The helper must not be the place where this policy lives: the broker runs host-side,
    // where the agent cannot edit it.
    const broker = await startFakeBroker({ ok: true, username: 'u', password: 'p' });
    try {
      const io = capture('protocol=http\nhost=github.com\npath=acme/widget.git\n');
      await runHelper(['get'], { ...io, env: { GIT_BROKER_SOCKET: broker.socketPath } });
      assert.equal(io.stdoutText(), 'username=u\npassword=p\n');
    } finally {
      await broker.close();
    }
  });

  it('refuses a request with no repository path and names the fix', async () => {
    const io = capture('protocol=https\nhost=github.com\n');
    await runHelper(['get'], { ...io, env: { GIT_BROKER_SOCKET: '/nonexistent' } });
    assert.equal(io.stdoutText(), 'quit=1\n');
    assert.match(io.stderrText(), /credential\.useHttpPath true/);
  });

  it('refuses with quit=1 when the broker cannot be reached', async () => {
    const io = capture(CLIENT_REQUEST);
    await runHelper(['get'], { ...io, env: { GIT_BROKER_SOCKET: path.join(tempDir, 'missing.sock') } });
    assert.equal(io.stdoutText(), 'quit=1\n', 'quit=1 stops git from trying another helper');
    assert.match(io.stderrText(), /cannot reach the broker/);
  });

  it('prints only the two protocol lines on success', async () => {
    const broker = await startFakeBroker({ ok: true, username: 'x-access-token', password: 'ghs_fake' });
    try {
      const io = capture(CLIENT_REQUEST);
      await runHelper(['get'], { ...io, env: { GIT_BROKER_SOCKET: broker.socketPath } });
      assert.equal(io.stdoutText(), 'username=x-access-token\npassword=ghs_fake\n');
    } finally {
      await broker.close();
    }
  });

  it('surfaces a broker refusal without inventing a credential', async () => {
    const broker = await startFakeBroker({
      ok: false,
      code: 'repo-not-allowed',
      reason: 'repository is not allowlisted',
    });
    try {
      const io = capture(CLIENT_REQUEST);
      await runHelper(['get'], { ...io, env: { GIT_BROKER_SOCKET: broker.socketPath } });
      assert.equal(io.stdoutText(), 'quit=1\n');
      assert.match(io.stderrText(), /repo-not-allowed/);
    } finally {
      await broker.close();
    }
  });
});
