/** Audit rotation, retention and redaction. */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { createAudit, redact } from '../../packages/host/src/audit.ts'
import { validateConfig } from '../../packages/host/src/config.ts'

function records(path: string): string[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(line => line !== '')
}

describe('the audit log', () => {
  it('redacts secret-looking fields but keeps the fingerprint', () => {
    assert.deepEqual(
      redact({ token: 'secret', token_fingerprint: 'abc', password: 'x', repo: 'acme/widget' }),
      {
        token: '<redacted>',
        token_fingerprint: 'abc',
        password: '<redacted>',
        repo: 'acme/widget',
      },
    )
  })

  it('writes nothing when the path is null', () => {
    const sink = createAudit({ path: null })
    sink.record({ repo: 'acme/widget' })
    assert.equal(sink.path, null)
  })

  it('rotates before the active file exceeds the limit and keeps the requested count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcb-audit-'))
    const path = join(root, 'audit.jsonl')
    try {
      const sink = createAudit({
        path,
        maxBytes: 120,
        keep: 2,
        now: () => Date.parse('2026-01-01T00:00:00Z'),
      })
      for (let index = 0; index < 10; index += 1) {
        sink.record({ event: index, token: 'secret', repo: 'acme/widget' })
      }
      await sink.close()

      assert.equal(existsSync(`${path}.3`), false)
      assert.equal(existsSync(`${path}.1`), true)
      assert.equal(existsSync(`${path}.2`), true)

      const combined = [path, `${path}.1`, `${path}.2`].flatMap(file => records(file))
      assert.equal(
        combined.some(line => line.includes('secret')),
        false,
      )
      assert.equal(
        combined.some(line => line.includes('acme/widget')),
        true,
      )
      for (const file of [path, `${path}.1`, `${path}.2`]) {
        assert.equal(existsSync(file), true, file)
        if (process.platform !== 'win32') {
          assert.equal(statSync(file).mode & 0o777, 0o600, file)
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recreates a missing active file before the next record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcb-audit-recover-'))
    const path = join(root, 'audit.jsonl')
    try {
      const sink = createAudit({ path })
      sink.record({ event: 'first' })
      rmSync(path)
      sink.record({ event: 'second' })
      await sink.close()
      assert.match(readFileSync(path, 'utf8'), /second/u)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('validates the rotation options', () => {
    const base = {
      socketPath: '/tmp/gcb.sock',
      hosts: { 'github.com': { provider: 'static', allow: ['acme/widget'] } },
    }
    assert.doesNotThrow(() => validateConfig({ ...base, auditMaxBytes: 1024, auditKeep: 3 }))
    assert.throws(() => validateConfig({ ...base, auditMaxBytes: 0 }), /auditMaxBytes/u)
    assert.throws(() => validateConfig({ ...base, auditKeep: 1.5 }), /auditKeep/u)
    assert.doesNotThrow(() => validateConfig({ ...base, actions: { 'pr:view': { deny: true } } }))
    assert.throws(
      () => validateConfig({ ...base, actions: { 'not:an-action': { deny: true } } }),
      /not a catalogued action/u,
    )
    assert.throws(
      () => validateConfig({ ...base, actions: { 'pr:view': { deny: null } } }),
      /deny must be a boolean/u,
    )
    assert.doesNotThrow(() =>
      validateConfig({
        ...base,
        hosts: {
          'github.com': {
            provider: 'static',
            allow: ['acme/widget'],
            actions: { 'pr:view': { deny: true } },
          },
        },
      }),
    )
    assert.throws(
      () =>
        validateConfig({
          ...base,
          hosts: {
            'github.com': {
              provider: 'static',
              allow: ['acme/widget'],
              actions: { 'not:an-action': { deny: true } },
            },
          },
        }),
      /not a catalogued action/u,
    )
    assert.doesNotThrow(() => validateConfig({ ...base, actionRateLimit: 1 }))
    assert.throws(() => validateConfig({ ...base, actionRateLimit: 0 }), /actionRateLimit/u)
    assert.throws(() => validateConfig({ ...base, actionRateLimit: 1.5 }), /actionRateLimit/u)
  })
})
