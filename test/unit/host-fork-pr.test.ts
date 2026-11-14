/** A lifecycle `pr create` on the parent of an allowlisted fork, driven end to end. */
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { channelDir, readResult, writeRequest } from '../../packages/core/src/host-request.ts'
import { runHostBroker } from '../../packages/host/src/commands/host.ts'

interface Fixture {
  readonly answer: ReturnType<typeof readResult>
  readonly argv: string[]
  readonly cleanup: () => void
}

async function runFixture(metadata: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'host-broker-pr-fork-'))
  const repo = join(root, 'checkout')
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
  const config = join(root, 'broker.config.yml')
  writeFileSync(
    config,
    `socketPath: ${join(root, 'broker.sock')}\nhosts:\n  github.com:\n    provider: static\n    username: x\n    password: y\n    allowFork: true\n    allow:\n      - JounQin/vitehub\n`,
    'utf8',
  )
  const dir = channelDir(join(repo, '.git'))
  const argvFile = join(root, 'argv')
  const command = join(root, 'not-gh')
  writeFileSync(
    command,
    `#!/bin/sh
if [ "$1" = api ]; then
  case "$2" in repos/JounQin/vitehub|repos/jounqin/vitehub) ;; *) echo "unexpected $2" >&2; exit 1;; esac
  echo '${metadata}'
  exit 0
fi
printf '%s\n' "$@" > ${argvFile}
echo "https://github.com/vite-hub/vitehub/pull/9"
`,
    'utf8',
  )
  chmodSync(command, 0o755)
  try {
    const id = writeRequest(dir, {
      repo: 'vite-hub/vitehub',
      head: 'feat/x',
      base: 'next',
      title: 'x',
      body: '',
    })
    assert.equal(
      await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']),
      0,
    )
    const argv = existsSync(argvFile) ? readFileSync(argvFile, 'utf8').trim().split('\n') : []
    return {
      answer: readResult(dir, id),
      argv,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}

describe('opening a pull request on a fork parent', () => {
  it('allows it when allowFork is set', async () => {
    const fixture = await runFixture(
      '{"fork":true,"private":false,"visibility":"public","parent":{"full_name":"vite-hub/vitehub","private":false,"visibility":"public"}}',
    )
    try {
      assert.equal(fixture.answer?.number, 9, JSON.stringify(fixture.answer))
      assert.equal(fixture.argv[fixture.argv.indexOf('--repo') + 1], 'vite-hub/vitehub')
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a private fork', async () => {
    const fixture = await runFixture(
      '{"fork":true,"private":true,"visibility":"private","parent":{"full_name":"vite-hub/vitehub","private":false,"visibility":"public"}}',
    )
    try {
      assert.match(String(fixture.answer?.error ?? ''), /not in the allowlist/u)
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a private parent', async () => {
    const fixture = await runFixture(
      '{"fork":true,"private":false,"visibility":"public","parent":{"full_name":"vite-hub/vitehub","private":true,"visibility":"private"}}',
    )
    try {
      assert.match(String(fixture.answer?.error ?? ''), /not in the allowlist/u)
    } finally {
      fixture.cleanup()
    }
  })
})
