/** `gcb doctor`: config validity, digest, last reload record and socket state. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { runDoctor } from '../../packages/host/src/commands/doctor.ts';

function fixture(): { root: string; config: string; audit: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-doctor-'));
  const config = path.join(root, 'broker.config.yml');
  const audit = path.join(root, 'audit.jsonl');
  fs.writeFileSync(
    config,
    [
      `socketPath: ${path.join(root, 'broker.sock')}`,
      'socketMode: 384',
      `auditPath: ${audit}`,
      'hosts:',
      '  github.com:',
      '    provider: static',
      '    allow: [a/one]',
      '    username: x-access-token',
      '    password: a-secret',
      '',
    ].join('\n'),
  );
  return { root, config, audit, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function output(args: readonly string[], expected = 0): Promise<string> {
  let text = '';
  assert.equal(
    await runDoctor(args, (line) => {
      text += line + '\n';
    }),
    expected,
  );
  return text;
}

describe('gcb doctor', () => {
  it('reports the config digest and the last reload record', async () => {
    const host = fixture();
    try {
      const digest = createHash('sha256').update(fs.readFileSync(host.config)).digest('hex');
      fs.writeFileSync(
        host.audit,
        JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', event: 'config', decision: 'reload-failed', reason: 'bad' }) +
          '\n' +
          JSON.stringify({ ts: '2026-01-01T00:01:00.000Z', event: 'config', decision: 'reload', digest }) +
          '\n',
      );
      const text = await output(['--config', host.config]);
      assert.match(text, new RegExp(`digest: ${digest}`));
      assert.match(text, /last reload: reload at 2026-01-01T00:01:00.000Z \(digest matches\)/);
      assert.match(text, new RegExp(`socket: missing: ${path.join(host.root, 'broker.sock')}`));
      assert.match(text, /audit: .* \(configured; the running daemon may still use its startup path\)/);
    } finally {
      host.cleanup();
    }
  });

  it('reports a failed reload reason before a partial trailing line', async () => {
    const host = fixture();
    try {
      fs.writeFileSync(
        host.audit,
        JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', event: 'config', decision: 'reload-failed', reason: 'bad' }) +
          '\n{"ts":"2026-01-01T00:02:00.000Z","event":"con',
      );
      const text = await output(['--config', host.config]);
      assert.match(text, /last reload: reload-failed at 2026-01-01T00:00:00.000Z \(digest unknown\) — bad/);
    } finally {
      host.cleanup();
    }
  });

  it('skips an unrelated record after the config record', async () => {
    const host = fixture();
    try {
      fs.writeFileSync(
        host.audit,
        JSON.stringify({ ts: '2026-01-01T00:01:00.000Z', event: 'config', decision: 'reload', digest: 'abc' }) +
          '\n' +
          JSON.stringify({ ts: '2026-01-01T00:02:00.000Z', event: 'credential', decision: 'allow' }) +
          '\n',
      );
      const text = await output(['--config', host.config]);
      assert.match(text, /last reload: reload at 2026-01-01T00:01:00.000Z \(digest differs\)/);
    } finally {
      host.cleanup();
    }
  });

  it('reports a regular file where the broker expects a socket', async () => {
    const host = fixture();
    try {
      fs.writeFileSync(path.join(host.root, 'broker.sock'), 'not a socket');
      const text = await output(['--config', host.config]);
      assert.match(text, /socket: regular file \(broker refuses\):/);
    } finally {
      host.cleanup();
    }
  });

  it('still reports the audit record when the config is invalid', async () => {
    const host = fixture();
    try {
      fs.writeFileSync(host.config, `auditPath: ${host.audit}\nhosts: [unterminated\n`);
      fs.writeFileSync(
        host.audit,
        JSON.stringify({ ts: '2026-01-01T00:03:00.000Z', event: 'config', decision: 'reload-failed', reason: 'bad' }) + '\n',
      );
      const text = await output(['--config', host.config], 1);
      assert.match(text, /config: .* invalid:/);
      assert.match(text, /last reload: reload-failed at 2026-01-01T00:03:00.000Z \(digest unknown\) — bad/);
    } finally {
      host.cleanup();
    }
  });

  it('reports a symlink where the broker expects a socket', async () => {
    const host = fixture();
    try {
      fs.symlinkSync(path.join(host.root, 'elsewhere'), path.join(host.root, 'broker.sock'));
      const text = await output(['--config', host.config]);
      assert.match(text, /socket: symlink \(broker refuses\):/);
    } finally {
      host.cleanup();
    }
  });

  it('finds a config record that straddles a 64 KiB audit chunk', async () => {
    const host = fixture();
    try {
      const record = JSON.stringify({ ts: '2026-01-01T00:04:00.000Z', event: 'config', decision: 'reload' });
      const target = 64 * 1024 + 10;
      const filler = 'x'.repeat(target - record.length - 2);
      fs.writeFileSync(host.audit, `${record}\n${filler}\n`);
      const size = fs.statSync(host.audit).size;
      assert.ok(size > 64 * 1024 && size - 64 * 1024 < record.length, 'the read boundary is inside the record');
      const text = await output(['--config', host.config]);
      assert.match(text, /last reload: reload at 2026-01-01T00:04:00.000Z \(digest unknown\)/);
    } finally {
      host.cleanup();
    }
  });

  it('keeps a hash in an audit path when the config is invalid', async () => {
    const host = fixture();
    try {
      const audit = path.join(host.root, 'a#1', 'audit.jsonl');
      fs.mkdirSync(path.dirname(audit));
      fs.writeFileSync(audit, JSON.stringify({ ts: '2026-01-01T00:05:00.000Z', event: 'config', decision: 'reload' }) + '\n');
      fs.writeFileSync(host.config, `auditPath: ${audit}\nhosts: [unterminated\n`);
      const text = await output(['--config', host.config], 1);
      assert.match(text, /last reload: reload at 2026-01-01T00:05:00.000Z/);
    } finally {
      host.cleanup();
    }
  });

  it('reports a socket mode mismatch against the configured mode', async () => {
    const host = fixture();
    const socketPath = path.join(host.root, 'broker.sock');
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.end('{"ok":true,"auditPath":null}\n'));
    });
    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      fs.chmodSync(socketPath, 0o644);
      const text = await output(['--config', host.config]);
      assert.match(text, /socket: present \(mode 644, expected 600\):/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      host.cleanup();
    }
  });

  it('reads the active audit path reported by the daemon', async () => {
    const host = fixture();
    const socketPath = path.join(host.root, 'daemon.sock');
    const active = path.join(host.root, 'active.jsonl');
    fs.writeFileSync(active, JSON.stringify({ ts: '2026-01-01T00:08:00.000Z', event: 'config', decision: 'reload' }) + '\n');
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        const answer = JSON.stringify({ ok: true, auditPath: active }) + '\n';
        // Split the frame across data events; the line reader must reassemble it.
        socket.write(answer.slice(0, 12));
        setTimeout(() => socket.end(answer.slice(12)), 10);
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      fs.writeFileSync(host.config, fs.readFileSync(host.config, 'utf8').replace(/socketPath: .*\n/, `socketPath: ${socketPath}\n`));
      const text = await output(['--config', host.config]);
      assert.match(text, /last reload: reload at 2026-01-01T00:08:00.000Z/);
      assert.match(text, new RegExp(`audit: ${active} \\(active daemon path\\)`));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      host.cleanup();
    }
  });

  it('labels a daemon that reports no active audit log', async () => {
    const host = fixture();
    const socketPath = path.join(host.root, 'daemon.sock');
    fs.writeFileSync(host.audit, JSON.stringify({ ts: '2026-01-01T00:09:00.000Z', event: 'config', decision: 'reload' }) + '\n');
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.end('{"ok":true,"auditPath":null}\n'));
    });
    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      fs.writeFileSync(host.config, fs.readFileSync(host.config, 'utf8').replace(/socketPath: .*\n/, `socketPath: ${socketPath}\n`));
      const text = await output(['--config', host.config]);
      assert.match(text, /last reload: reload at 2026-01-01T00:09:00.000Z/);
      assert.match(text, new RegExp(`audit: ${host.audit} \\(configured; the running daemon writes no audit log\\)`));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      host.cleanup();
    }
  });

  it('falls back within the ping bound when the daemon never answers', { timeout: 5_000 }, async () => {
    const started = Date.now();
    const host = fixture();
    const socketPath = path.join(host.root, 'silent.sock');
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        // Deliberately no response: doctor must time out and use the configured path.
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      fs.writeFileSync(host.config, fs.readFileSync(host.config, 'utf8').replace(/socketPath: .*\n/, `socketPath: ${socketPath}\n`));
      const text = await output(['--config', host.config]);
      assert.match(text, /audit: .* \(configured; the running daemon may still use its startup path\)/);
      assert.ok(Date.now() - started < 1_500, 'the ping bound is 500ms, not seconds');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      host.cleanup();
    }
  });

  it('queries the daemon when an invalid config still names its socket', async () => {
    const host = fixture();
    const socketPath = path.join(host.root, 'invalid-config.sock');
    const active = path.join(host.root, 'active-invalid.jsonl');
    fs.writeFileSync(active, JSON.stringify({ ts: '2026-01-01T00:10:00.000Z', event: 'config', decision: 'reload' }) + '\n');
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.end(JSON.stringify({ ok: true, auditPath: active }) + '\n'));
    });
    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      fs.writeFileSync(host.config, `'socketPath': ${socketPath}\nhosts: [unterminated\n`);
      const text = await output(['--config', host.config], 1);
      assert.match(text, /last reload: reload at 2026-01-01T00:10:00.000Z/);
      assert.match(text, new RegExp(`audit: ${active} \\(active daemon path\\)`));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      host.cleanup();
    }
  });

  it('falls back when an older daemon omits auditPath', async () => {
    const host = fixture();
    const socketPath = path.join(host.root, 'old.sock');
    const server = net.createServer((socket) => {
      socket.once('data', () => socket.end('{"ok":true,"version":"0.9.0","hosts":[]}\n'));
    });
    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      fs.writeFileSync(host.config, fs.readFileSync(host.config, 'utf8').replace(/socketPath: .*\n/, `socketPath: ${socketPath}\n`));
      const text = await output(['--config', host.config]);
      assert.match(text, /audit: .* \(configured; the running daemon may still use its startup path\)/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      host.cleanup();
    }
  });

  it('treats an empty auditPath as no log', async () => {
    const host = fixture();
    try {
      fs.writeFileSync(host.config, fs.readFileSync(host.config, 'utf8').replace(/auditPath: .*\n/, "auditPath: ''\n"));
      const text = await output(['--config', host.config]);
      assert.match(text, /no auditPath configured/);
      assert.doesNotMatch(text, /^audit:/m, 'an empty audit path is not printed as configured');
    } finally {
      host.cleanup();
    }
  });

  it('keeps a multi-byte reason when the chunk boundary splits it', async () => {
    const host = fixture();
    try {
      const record = JSON.stringify({
        ts: '2026-01-01T00:07:00.000Z',
        event: 'config',
        decision: 'reload-failed',
        reason: 'café 世界',
      });
      const offset = Buffer.byteLength(record.slice(0, record.indexOf('世'))) + 1;
      const target = 64 * 1024 + offset;
      const filler = 'x'.repeat(target - Buffer.byteLength(record) - 1);
      fs.writeFileSync(host.audit, `${record}\n${filler}`);
      assert.equal(fs.statSync(host.audit).size, target);
      const text = await output(['--config', host.config]);
      assert.match(text, /café 世界/);
      assert.match(text, /reload-failed/);
    } finally {
      host.cleanup();
    }
  });

  it('reports an unreadable audit path instead of an empty log', async () => {
    const host = fixture();
    try {
      fs.mkdirSync(host.audit);
      const text = await output(['--config', host.config]);
      assert.match(text, /last reload: \(cannot read the audit log: .*not a regular file/);
    } finally {
      host.cleanup();
    }
  });

  it('does not block on a FIFO audit path', { skip: process.platform === 'win32' }, async () => {
    const host = fixture();
    try {
      execFileSync('mkfifo', [host.audit]);
      const text = await output(['--config', host.config]);
      assert.match(text, /last reload: \(cannot read the audit log: .*not a regular file/);
    } finally {
      host.cleanup();
    }
  });

  it('reads a quoted auditPath key when the config is invalid', async () => {
    const host = fixture();
    try {
      fs.writeFileSync(host.config, `'auditPath': ${host.audit}\nhosts: [unterminated\n`);
      fs.writeFileSync(host.audit, JSON.stringify({ ts: '2026-01-01T00:06:00.000Z', event: 'config', decision: 'reload' }) + '\n');
      const text = await output(['--config', host.config], 1);
      assert.match(text, /last reload: reload at 2026-01-01T00:06:00.000Z/);
    } finally {
      host.cleanup();
    }
  });

  it('reports no reload record when the audit log is absent', async () => {
    const host = fixture();
    try {
      const text = await output(['--config', host.config]);
      assert.match(text, /no config record in the audit log/);
    } finally {
      host.cleanup();
    }
  });
});
