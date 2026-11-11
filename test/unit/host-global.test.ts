/** The host-submit fallback for a caller without a checkout. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { submitToHostBroker } from '../../packages/client/src/commands/host-submit.ts'
import {
  globalChannelDir,
  listRequests,
  writeHostBroker,
  writeResult,
} from '../../packages/core/src/host-request.ts'

describe('host submit outside a checkout', () => {
  it('uses the global channel and requires an explicit repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gcb-host-global-'))
    const previousHome = process.env['HOME']
    const previousCwd = process.cwd()
    process.env['HOME'] = root
    process.chdir(root)
    const dir = globalChannelDir(root)
    mkdirSync(dir, { recursive: true })
    writeHostBroker(dir, { pid: 1, kinds: ['fork'] })
    const answering = (async () => {
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline) {
        const [id] = listRequests(dir)
        if (id !== undefined) {
          writeResult(dir, id, { url: 'https://github.com/me/widget' })
          return
        }
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error('no request was written')
    })()
    try {
      const code = await submitToHostBroker(
        { kind: 'fork', repo: 'acme/widget' },
        answer => `ok ${answer.url ?? ''}`,
      )
      assert.equal(code, 0)
      await answering
    } finally {
      process.chdir(previousCwd)
      if (previousHome === undefined) {
        delete process.env['HOME']
      } else {
        process.env['HOME'] = previousHome
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
})
