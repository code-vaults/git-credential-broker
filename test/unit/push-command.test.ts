/** The client-side scan and tracking-ref logic used by `gcb push`. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { scanAsUser, updateTrackingRef } from '../../packages/client/src/commands/push.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function repository(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gcb-push-command-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@example.invalid')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'commit', '--allow-empty', '-qm', 'initial')
  return dir
}

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

describe('gcb push tracking refs', () => {
  it('updates a wildcard tracking ref for the same fetch repository', () => {
    const dir = repository()
    try {
      git(dir, 'remote', 'add', 'origin', 'https://github.com/acme/widget.git')
      git(dir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
      const commit = git(dir, 'rev-parse', 'HEAD')
      updateTrackingRef('origin', 'feat/x', commit, 'acme/widget', dir)
      assert.equal(git(dir, 'rev-parse', 'refs/remotes/origin/feat/x'), commit)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not update a tracking ref when the fetch remote differs', () => {
    const dir = repository()
    try {
      git(dir, 'remote', 'add', 'origin', 'https://github.com/other/widget.git')
      git(dir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
      const commit = git(dir, 'rev-parse', 'HEAD')
      updateTrackingRef('origin', 'feat/x', commit, 'acme/widget', dir)
      assert.throws(() => git(dir, 'rev-parse', '--verify', 'refs/remotes/origin/feat/x'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
