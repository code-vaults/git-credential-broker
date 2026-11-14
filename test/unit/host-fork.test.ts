import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, it } from 'node:test'

import { channelDir, readResult, writeRequest } from '../../packages/core/src/host-request.ts'
import { runHostBroker } from '../../packages/host/src/commands/host.ts'

let statusHome = ''
let previousHome: string | undefined
let previousUserProfile: string | undefined
before(() => {
  statusHome = mkdtempSync(join(tmpdir(), 'host-fork-home-'))
  previousHome = process.env['HOME']
  previousUserProfile = process.env['USERPROFILE']
  process.env['HOME'] = statusHome
  process.env['USERPROFILE'] = statusHome
})
after(() => {
  rmSync(statusHome, { recursive: true, force: true })
  if (previousHome === undefined) {
    delete process.env['HOME']
  } else {
    process.env['HOME'] = previousHome
  }
  if (previousUserProfile === undefined) {
    delete process.env['USERPROFILE']
  } else {
    process.env['USERPROFILE'] = previousUserProfile
  }
})

it('runs an action on the parent of an allowlisted fork', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-broker-fork-'))
  const repo = join(root, 'checkout')
  mkdirSync(join(repo, '.git'), { recursive: true })
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8')
  const config = join(root, 'broker.config.yml')
  writeFileSync(
    config,
    `socketPath: ${join(root, 'broker.sock')}\nhosts:\n  ghe.example:\n    provider: github-app\n    clientId: Iv1.clientid\n    privateKeyPem: x\n    allowFork: true\n    allow:\n      - alice/widget\n`,
    'utf8',
  )
  const dir = channelDir(join(repo, '.git'))
  const command = join(root, 'not-gh')
  writeFileSync(
    command,
    '#!/bin/sh\nif [ "$1" = api ]; then\n  case "$2" in repos/alice/widget) ;; *) echo "unexpected $2" >&2; exit 1;; esac\n  echo \'{"fork":true,"private":false,"visibility":"public","parent":{"full_name":"Acme/Widget","private":false,"visibility":"public"}}\'\n  exit 0\nfi\necho "fork action"\n',
    'utf8',
  )
  chmodSync(command, 0o755)
  try {
    const id = writeRequest(dir, {
      kind: 'action',
      action: 'issue:create',
      repo: 'acme/widget',
      host: 'ghe.example',
      values: { title: 't', body: 'b' },
    })
    assert.equal(
      await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']),
      0,
    )
    assert.equal(readResult(dir, id)?.stdout, 'fork action\n')
    assert.equal(existsSync(join(repo, '.git', 'gcb', 'host-broker', `${id}.json`)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
