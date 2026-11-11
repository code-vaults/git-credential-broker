/** The client-side --as-user scan for `gcb push`. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { scanAsUser } from '../../packages/client/src/commands/push.ts'

describe('gcb push argument scanning', () => {
  it('keeps the bare form from consuming the remote', () => {
    assert.deepEqual(scanAsUser(['--as-user', 'origin', 'feat/x']), {
      argv: ['origin', 'feat/x', '--as-user'],
      account: undefined,
      bare: true,
    })
  })

  it('reads the equals form as the account', () => {
    assert.deepEqual(scanAsUser(['--as-user=octocat', 'origin', 'feat/x']), {
      argv: ['origin', 'feat/x', '--as-user'],
      account: 'octocat',
      bare: false,
    })
  })
})
