import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  brokerReadsPath,
  refreshTokenPath,
  resolveAuthorizationPlacement,
} from '../../packages/host/src/commands/authorize.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const hostBin = fileURLToPath(new URL('../../packages/host/bin/gcb.js', import.meta.url))
const configPath = '/deploy/broker.config.yml'

describe('gcb authorize', () => {
  it('documents the broker-container mode', () => {
    const output = execFileSync(
      process.execPath,
      ['--conditions=development', hostBin, 'authorize', '--help'],
      { cwd: root, encoding: 'utf8' },
    )
    assert.match(output, /--broker-container/u)
    assert.match(output, /shared with the agent container/u)
  })

  it('refuses a container placement without the explicit flag', () => {
    assert.throws(
      () =>
        resolveAuthorizationPlacement({
          configPath,
          brokerContainer: false,
          isInsideContainer: () => true,
        }),
      /run this on the host/u,
    )
    assert.throws(
      () =>
        resolveAuthorizationPlacement({
          configPath,
          brokerContainer: false,
          isInsideContainer: () => false,
          mountedPath: () => '/mnt/shared',
        }),
      /is inside \/mnt\/shared/u,
    )
  })

  it('allows the broker-container placement and resolves the host-side target', () => {
    const placement = resolveAuthorizationPlacement({
      configPath,
      brokerContainer: true,
      writable: () => true,
    })
    assert.equal(placement.target, refreshTokenPath(configPath))
    assert.match(placement.warning ?? '', /not shared with the agent container/u)
  })

  it('does not anchor the target on the key directory', () => {
    const keyPath = '/broker/key/app.pem'
    assert.notEqual(refreshTokenPath(configPath), brokerReadsPath(keyPath))
    assert.equal(
      resolveAuthorizationPlacement({
        configPath,
        brokerContainer: true,
        writable: () => true,
      }).target,
      refreshTokenPath(configPath),
    )
  })

  it('accepts a new subdirectory beneath a writable mount', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-authorize-'))
    try {
      const target = path.join(root, 'new', 'user.refresh')
      assert.equal(
        resolveAuthorizationPlacement({ configPath, to: target, brokerContainer: true }).target,
        target,
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a read-only broker-container target', () => {
    assert.throws(
      () =>
        resolveAuthorizationPlacement({
          configPath,
          brokerContainer: true,
          writable: () => false,
        }),
      /is not writable/u,
    )
  })
})
