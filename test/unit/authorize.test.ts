import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const hostBin = fileURLToPath(new URL('../../packages/host/bin/gcb.js', import.meta.url))

describe('gcb authorize', () => {
  it('documents the broker-container mode', () => {
    const output = execFileSync(process.execPath, ['--conditions=development', hostBin, 'authorize', '--help'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.match(output, /--broker-container/u)
    assert.match(output, /never the agent container/u)
  })
})
