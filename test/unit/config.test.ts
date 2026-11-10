/**
 * Tests for configuration validation.
 *
 * This is the boundary that decides whether a typo becomes a loud startup failure or a silent
 * denial, so the interesting cases are the malformed ones.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

import { loadConfig, validateConfig } from '../../packages/host/src/config.ts'

/**
 * A minimal valid configuration, with overrides applied on top.
 *
 * @param overrides - Top-level keys to replace.
 * @returns The raw configuration object.
 */
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    socketPath: '/run/git-cred-broker/broker.sock',
    hosts: { 'github.com': { provider: 'static', allow: ['acme/widget'], password: 'p' } },
    ...overrides,
  }
}

/**
 * Build a configuration with one host block replaced.
 *
 * @param host - The host block.
 * @returns The raw configuration object.
 */
function withHost(host: Record<string, unknown>): Record<string, unknown> {
  return base({ hosts: { 'github.com': host } })
}

describe('loadConfig', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'gcb-config-'))
  after(() => rmSync(scratch, { recursive: true, force: true }))

  it('parses YAML', () => {
    const file = path.join(scratch, 'broker.config.yml')
    writeFileSync(
      file,
      [
        'socketPath: /run/git-cred-broker/broker.sock',
        'hosts:',
        '  github.com:',
        '    provider: static',
        '    allow:',
        '      - acme/widget',
        '    password: p',
        '',
      ].join('\n'),
    )
    const config = loadConfig(file)
    assert.deepEqual(config.hosts['github.com']?.allow, ['acme/widget'])
    assert.equal(config.socketMode, 0o660)
  })

  it('accepts the .yaml spelling too', () => {
    const file = path.join(scratch, 'broker.config.yaml')
    writeFileSync(
      file,
      'socketPath: /run/x.sock\nhosts:\n  github.com:\n    provider: static\n    allow: [acme/widget]\n    password: p\n',
    )
    assert.deepEqual(loadConfig(file).hosts['github.com']?.allow, ['acme/widget'])
  })

  it('reports malformed YAML', () => {
    const file = path.join(scratch, 'broken.yml')
    writeFileSync(file, 'socketPath: [')
    assert.throws(() => loadConfig(file), /not valid YAML/)
  })
})

describe('validateConfig', () => {
  it('applies defaults and accepts a minimal configuration', () => {
    const config = validateConfig(base())
    assert.equal(config.socketMode, 0o660)
    assert.equal(config.auditPath, null)
    assert.equal(config.tokenCacheSkewSeconds, 300)
    assert.deepEqual(config.hosts['github.com']?.allow, ['acme/widget'])
  })

  it('requires a socket path and at least one host', () => {
    assert.throws(() => validateConfig({ hosts: {} }), /socketPath is required/)
    assert.throws(
      () => validateConfig({ socketPath: '/x.sock' }),
      /hosts must be a non-empty object/,
    )
    assert.throws(
      () => validateConfig({ socketPath: '/x.sock', hosts: {} }),
      /hosts must be a non-empty object/,
    )
  })

  it('rejects an unknown provider and an empty allowlist', () => {
    assert.throws(
      () => validateConfig(withHost({ provider: 'pat', allow: ['a/b'] })),
      /provider must be one of/,
    )
    assert.throws(
      () => validateConfig(withHost({ provider: 'static', allow: [] })),
      /allow must be a non-empty array/,
    )
    assert.throws(
      () => validateConfig(withHost({ provider: 'static' })),
      /allow must be a non-empty array/,
    )
  })

  it('rejects a malformed allowlist entry rather than silently matching nothing', () => {
    for (const bad of ['acme', 'acme/other/extra', 'acme/wid*', '', 'acme/..', 7]) {
      assert.throws(
        () => validateConfig(withHost({ provider: 'static', allow: [bad], password: 'p' })),
        /not a valid|only strings/,
        `expected ${JSON.stringify(bad)} to be rejected`,
      )
    }
  })

  it('accepts the public-read and fork-push opt-ins as booleans', () => {
    const config = validateConfig(
      withHost({
        provider: 'static',
        allow: ['a/b'],
        password: 'p',
        allowPublicRead: true,
        allowForkPush: true,
      }),
    )
    assert.equal(config.hosts['github.com']?.allowPublicRead, true)
    assert.equal(config.hosts['github.com']?.allowForkPush, true)
    assert.throws(
      () =>
        validateConfig(
          withHost({ provider: 'static', allow: ['a/b'], password: 'p', allowPublicRead: 'yes' }),
        ),
      /allowPublicRead must be a boolean/,
    )
    assert.throws(
      () =>
        validateConfig(
          withHost({ provider: 'static', allow: ['a/b'], password: 'p', allowForkPush: 'yes' }),
        ),
      /allowForkPush must be a boolean/,
    )
  })

  it('accepts whole-segment wildcards', () => {
    const config = validateConfig(
      withHost({ provider: 'static', allow: ['acme/*', '*/*'], password: 'p' }),
    )
    assert.deepEqual(config.hosts['github.com']?.allow, ['acme/*', '*/*'])
  })

  it('validates field types rather than coercing them', () => {
    assert.throws(
      () => validateConfig(base({ socketMode: '432' })),
      /socketMode must be an integer/,
    )
    assert.throws(
      () => validateConfig(base({ tokenCacheSkewSeconds: 'soon' })),
      /tokenCacheSkewSeconds must be a number/,
    )
    assert.throws(() => validateConfig(base({ auditPath: 5 })), /auditPath must be a string/)
    assert.throws(
      () =>
        validateConfig(
          withHost({ provider: 'static', allow: ['a/b'], password: 'p', allowInsecureHttp: 'yes' }),
        ),
      /allowInsecureHttp must be a boolean/,
    )
    assert.throws(
      () =>
        validateConfig(
          withHost({ provider: 'static', allow: ['a/b'], password: 'p', expiresInSeconds: 'soon' }),
        ),
      /expiresInSeconds must be a finite number/,
    )
  })

  it('ignores top-level comment keys but still validates everything inside hosts', () => {
    const config = validateConfig({ ...base(), _comment: ['notes'] })
    assert.equal(typeof config.hosts['github.com'], 'object')
    assert.throws(
      () =>
        validateConfig(
          base({ hosts: { 'github.com': { provider: 'static', allow: ['a/b'] }, _note: 'oops' } }),
        ),
      /_note.*must be an object/,
    )
  })

  it('rejects a permission whose level is not a string', () => {
    assert.throws(
      () =>
        validateConfig(
          withHost({
            provider: 'github-app',
            allow: ['a/b'],
            privateKeyPem: 'k',
            clientId: 'c',
            permissions: { contents: 1 },
          }),
        ),
      /permissions\["contents"\] must be a string/,
    )
  })

  it('requires apiBaseUrl to be an https URL', () => {
    assert.throws(
      () =>
        validateConfig(
          withHost({
            provider: 'github-app',
            allow: ['a/b'],
            privateKeyPem: 'k',
            apiBaseUrl: 'http://ghe.example/api/v3',
          }),
        ),
      /apiBaseUrl must be an https URL/u,
    )
    const config = validateConfig(
      withHost({
        provider: 'github-app',
        allow: ['a/b'],
        privateKeyPem: 'k',
        apiBaseUrl: 'https://ghe.example/api/v3',
      }),
    )
    const host = config.hosts['github.com']
    assert.equal(host?.provider, 'github-app')
    if (host?.provider === 'github-app') {
      assert.equal(host.apiBaseUrl, 'https://ghe.example/api/v3')
    }
  })

  it('rejects host keys that differ only by case', () => {
    assert.throws(
      () =>
        validateConfig(
          base({
            hosts: {
              'github.com': { provider: 'static', allow: ['acme/widget'], password: 'p' },
              'GitHub.com': { provider: 'static', allow: ['acme/other'], password: 'p' },
            },
          }),
        ),
      /duplicates hosts\["github\.com"\] ignoring case/u,
    )
  })

  it('accepts the github-app identity fields and requires neither at this layer', () => {
    const config = validateConfig(
      withHost({
        provider: 'github-app',
        allow: ['a/b'],
        privateKeyPem: 'k',
        clientId: 'Iv1.x',
        appId: 42,
      }),
    )
    const host = config.hosts['github.com']
    assert.equal(host?.provider, 'github-app')
    assert.equal(host?.clientId, 'Iv1.x')
    assert.equal(host?.appId, 42)
  })
})
