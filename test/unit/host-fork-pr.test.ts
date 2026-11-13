/** A lifecycle `pr create` on the parent of an allowlisted fork, driven end to end. */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { channelDir, readResult, writeRequest } from '../../packages/core/src/host-request.ts'
import { runHostBroker } from '../../packages/host/src/commands/host.ts'

describe('opening a pull request on a fork parent', () => {
  it('allows it when allowFork is set', async () => {
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
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > ' +
        argvFile +
        '\necho "https://github.com/vite-hub/vitehub/pull/9"\n',
      'utf8',
    )
    chmodSync(command, 0o755)
    const originalFetch = globalThis.fetch
    const requested: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      requested.push(url)
      if (!url.toLowerCase().endsWith('/repos/jounqin/vitehub')) {
        throw new Error(`unexpected fork lookup: ${url}`)
      }
      return new Response(
        JSON.stringify({ fork: true, parent: { full_name: 'vite-hub/vitehub' } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }) as typeof fetch
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
      const answer = readResult(dir, id)
      assert.equal(answer?.number, 9, JSON.stringify(answer))
      const argv = readFileSync(argvFile, 'utf8').trim().split('\n')
      assert.equal(argv[argv.indexOf('--repo') + 1], 'vite-hub/vitehub')
      assert.deepEqual(requested, ['https://api.github.com/repos/jounqin/vitehub'])
    } finally {
      globalThis.fetch = originalFetch
      rmSync(root, { recursive: true, force: true })
    }
  })
})
