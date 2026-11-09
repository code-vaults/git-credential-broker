/** The README permission table is generated from the catalog; --check fails when it is stale. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../scripts/action-permissions.mjs', import.meta.url))
const root = fileURLToPath(new URL('../..', import.meta.url))

describe('README action permissions', () => {
  it('matches the generated catalog table', () => {
    assert.doesNotThrow(() =>
      execFileSync(process.execPath, [script, '--check'], { cwd: root, stdio: 'pipe' }),
    )
  })
})
