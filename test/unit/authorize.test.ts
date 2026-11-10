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

  it('does not let --broker-container bypass the container refusal', () => {
    assert.throws(
      () =>
        resolveAuthorizationPlacement({
          configPath,
          brokerContainer: true,
          isInsideContainer: () => true,
          writable: () => true,
        }),
      /run this on the host/u,
    )
  })

  it('refuses a symlink target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-authorize-link-'))
    try {
      const real = path.join(root, 'real.refresh')
      const link = path.join(root, 'user.refresh')
      fs.writeFileSync(real, '')
      fs.symlinkSync(real, link)
      assert.throws(
        () => resolveAuthorizationPlacement({
          configPath,
          to: link,
          brokerContainer: true,
          isInsideContainer: () => false,
        }),
        /is not writable/u,
      )
      const dangling = path.join(root, 'dangling.refresh')
      fs.symlinkSync(path.join(root, 'missing.refresh'), dangling)
      assert.throws(
        () => resolveAuthorizationPlacement({
          configPath,
          to: dangling,
          brokerContainer: true,
          isInsideContainer: () => false,
        }),
        /is not writable/u,
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('allows the broker-container placement and resolves the host-side target', () => {
    const placement = resolveAuthorizationPlacement({
      configPath,
      brokerContainer: true,
      isInsideContainer: () => false,
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
        isInsideContainer: () => false,
        writable: () => true,
      }).target,
      refreshTokenPath(configPath),
    )
  })

  it('secures an existing token file before the device flow', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-authorize-mode-'))
    try {
      const target = path.join(root, 'user.refresh')
      fs.writeFileSync(target, '', { mode: 0o664 })
      resolveAuthorizationPlacement({
        configPath,
        to: target,
        brokerContainer: true,
        isInsideContainer: () => false,
      })
      assert.equal(fs.statSync(target).mode & 0o777, 0o600)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts a new subdirectory beneath a writable mount', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-authorize-'))
    try {
      const target = path.join(root, 'new', 'user.refresh')
      assert.equal(
        resolveAuthorizationPlacement({
          configPath,
          to: target,
          brokerContainer: true,
          isInsideContainer: () => false,
        }).target,
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
          isInsideContainer: () => false,
          writable: () => false,
        }),
      /is not writable/u,
    )
  })
})
