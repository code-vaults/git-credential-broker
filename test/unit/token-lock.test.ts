/** The cross-process lock and atomic replacement for the refresh token. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  tokenLockPath,
  withTokenLock,
  writeTokenLocked,
} from '../../packages/host/src/token-lock.ts'

describe('the refresh-token lock', () => {
  it('serializes overlapping holders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcb-token-lock-'))
    const path = join(root, 'user.refresh')
    try {
      const order: string[] = []
      const first = withTokenLock(path, async () => {
        order.push('first-start')
        await new Promise(resolve => setTimeout(resolve, 25))
        order.push('first-end')
      })
      const second = withTokenLock(path, async () => {
        order.push('second')
      })
      await Promise.all([first, second])
      assert.deepEqual(order, ['first-start', 'first-end', 'second'])
      assert.equal(
        statSync(join(tokenLockPath(path), 'held'), { throwIfNoEntry: false }),
        undefined,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('releases the lock after a failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcb-token-lock-error-'))
    const path = join(root, 'user.refresh')
    try {
      await assert.rejects(
        withTokenLock(path, async () => {
          throw new Error('exchange failed')
        }),
        /exchange failed/,
      )
      assert.equal(await withTokenLock(path, async () => 'next'), 'next')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('replaces the token through a locked descriptor with mode 0600', () => {
    const root = mkdtempSync(join(tmpdir(), 'gcb-token-write-'))
    const path = join(root, 'user.refresh')
    try {
      writeFileSync(path, '', { mode: 0o600 })
      writeTokenLocked(path, 'first')
      writeTokenLocked(path, 'second')
      assert.equal(readFileSync(path, 'utf8'), 'second\n')
      if (process.platform !== 'win32') {
        assert.equal(statSync(path).mode & 0o777, 0o600)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
