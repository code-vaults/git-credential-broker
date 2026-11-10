/**
 * `push` — push a branch from the host, without a token entering the container.
 *
 * The container owns the checkout and its commits; the host broker owns the credentials. The request
 * therefore names only a repository and a branch, and the host rebuilds the HTTPS URL and runs git
 * with its own gh account. No remote URL or refspec from the container is trusted.
 */
import { execFileSync } from 'node:child_process'

import { BRANCH, HOST, LOGIN, REPOSITORY, fail, parseArgs, say } from 'gcb-core'

import { submitToHostBroker } from './host-submit.ts'
import { remoteRepo } from './remotes.ts'

const KNOWN_FLAGS = new Set([
  'help',
  'h',
  'as-user',
  'repo',
  'branch',
  'host',
  'proxy',
  'no-proxy',
])

export const PUSH_USAGE = `Usage: gcb push [options]

Push the current branch to its repository from the host, using the host's gh account. The token
never crosses into this container.

  --repo <owner/name>  Repository to push to (default: the origin remote)
  --branch <name>      Branch to push (default: the current branch)
  --host <host>        Host as configured (default: the origin remote's host, else github.com)
  --as-user            Use the host broker's own gh account
  --as-user <login>    Use ~/.config/gh-<login> on the host
  --proxy <url>        Use this proxy for the host git call
  --no-proxy           Reach GitHub directly for the host git call
  -h, --help           Show this help
`

/** The checked-out branch, refusing a detached HEAD rather than guessing a ref. */
function currentBranch(): string {
  try {
    const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (branch !== '') {
      return branch
    }
  } catch {
    // Fall through to the refusal.
  }
  fail('no current branch: pass --branch, or check out a branch')
}

export async function runPush(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help', 'h', 'no-proxy'] })
  if (args.has('help') || args.has('h')) {
    say(PUSH_USAGE)
    return 0
  }
  for (const name of args.names) {
    if (!KNOWN_FLAGS.has(name)) {
      fail('unknown option --' + name + ' for gcb push')
    }
  }
  const accounts = args.values('as-user')
  if (accounts.length > 1) {
    fail('--as-user may only be given once')
  }
  if (args.has('as-user') && accounts.length > 0) {
    fail('--as-user cannot be both bare and given a login')
  }
  const account = accounts[0]
  if (account !== undefined && !LOGIN.test(account)) {
    fail(`--as-user must be a GitHub login or no value, got ${JSON.stringify(account)}`)
  }
  const proxyValues = args.values('proxy')
  if (args.has('proxy') && proxyValues.length === 0) {
    fail('--proxy needs a value')
  }
  if (args.has('no-proxy') && (args.has('proxy') || proxyValues.length > 0)) {
    fail('--proxy and --no-proxy are mutually exclusive')
  }
  const proxy = args.has('no-proxy') ? null : args.value('proxy')

  const origin = remoteRepo('origin', process.cwd())
  const explicitRepo = args.value('repo')
  const repo = explicitRepo ?? (origin === undefined ? undefined : `${origin.owner}/${origin.repo}`)
  if (repo === undefined) {
    fail('--repo is required when the checkout has no usable origin remote')
  }
  if (!REPOSITORY.test(repo)) {
    fail(`--repo must be owner/name, got ${JSON.stringify(repo)}`)
  }
  const host = args.value('host') ?? origin?.host ?? 'github.com'
  if (!HOST.test(host)) {
    fail(`--host is not a usable host: ${JSON.stringify(host)}`)
  }
  const branch = args.value('branch') ?? currentBranch()
  if (!BRANCH.test(branch) || branch.includes('..') || branch.includes(':')) {
    fail(`--branch is not a usable branch name: ${JSON.stringify(branch)}`)
  }

  return submitToHostBroker(
    {
      kind: 'push',
      repo,
      host,
      branch,
      session: 'push',
      pid: process.pid,
      ...(account === undefined ? {} : { account }),
      ...(proxy === undefined ? {} : { proxy }),
    },
    answer =>
      `pushed ${branch} to ${repo}${answer.url === undefined ? '' : `: ${answer.url}`}${account === undefined ? '' : ` as ${account}`}`,
  )
}
