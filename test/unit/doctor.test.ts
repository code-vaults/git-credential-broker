/** `gcb doctor`: config validity, digest, last reload record and socket state. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
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

function output(args: readonly string[]): string {
  let text = '';
  const original = process.stdout.write;
  process.stdout.write = ((chunk: unknown) => {
    text += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(runDoctor(args), 0);
  } finally {
    process.stdout.write = original;
  }
  return text;
}

describe('gcb doctor', () => {
  it('reports the config digest and the last reload record', () => {
    const host = fixture();
    try {
      fs.writeFileSync(
        host.audit,
        JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', event: 'config', decision: 'reload-failed', reason: 'bad' }) +
          '\n' +
          JSON.stringify({ ts: '2026-01-01T00:01:00.000Z', event: 'config', decision: 'reload' }) +
          '\n',
      );
      const digest = createHash('sha256').update(fs.readFileSync(host.config)).digest('hex');
      const text = output(['--config', host.config]);
      assert.match(text, new RegExp(`digest: ${digest}`));
      assert.match(text, /last reload: reload at 2026-01-01T00:01:00.000Z/);
      assert.match(text, new RegExp(`socket: ${path.join(host.root, 'broker.sock')} missing`));
    } finally {
      host.cleanup();
    }
  });

  it('reports no reload record when the audit log is absent', () => {
    const host = fixture();
    try {
      const text = output(['--config', host.config]);
      assert.match(text, /no config record in the audit log/);
    } finally {
      host.cleanup();
    }
  });
});
