/**
 * `push` — push a branch from the host, without a token entering the container.
 *
 * The container owns the checkout and its commits; the host broker owns the credentials. The request
 * therefore names only a repository and a branch, and the host rebuilds the HTTPS URL and runs git
 * with its own gh account. No remote URL or refspec from the container is trusted.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { ANSWER_TIMEOUT_MS, BRANCH, LOGIN, fail, parseArgs, say } from 'gcb-core'

import { readHostTip, submitToHostBroker } from './host-submit.ts'
import { remoteRepo } from './remotes.ts'

const KNOWN_FLAGS = new Set([
  'help',
  'as-user',
  'force',
  'force-with-lease',
  'proxy',
  'no-proxy',
])

export const PUSH_USAGE = `Usage: gcb push [<remote> [<branch>]] [options]

Push a branch from the host, using the host's account. The token never crosses into this
container. The default remote is origin, and the default branch is the current one.

  --force              Overwrite the remote branch
  --force-with-lease   Overwrite only if the remote branch has not moved
  --as-user            Use the host broker's own gh account
  --as-user=<login>    Use ~/.config/gh-<login> on the host
  --proxy <url>        Use this proxy for the host git call
  --no-proxy           Reach GitHub directly for the host git call
  -h, --help           Show this help
`

/** The container's pre-push hook, when it exists and is executable. */
function prePushPath(): string | undefined {
  let hook: string
  try {
    hook = execFileSync('git', ['rev-parse', '--git-path', 'hooks/pre-push'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
  const path = resolve(hook)
  if (!existsSync(path)) {
    return undefined
  }
  try {
    accessSync(path, fsConstants.X_OK)
  } catch {
    return undefined
  }
  return path
}

/** Update the local remote-tracking ref only when the fetch remote maps this branch and repo. */
export function updateTrackingRef(
  remote: string,
  branch: string,
  commit: string,
  pushedRepo: string,
  cwd: string = process.cwd(),
): void {
  const fetched = remoteRepo(remote, cwd)
  if (fetched === undefined || `${fetched.owner}/${fetched.repo}` !== pushedRepo) {
    return
  }
  let specs: string[]
  try {
    specs = execFileSync('git', ['config', '--get-all', `remote.${remote}.fetch`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
  } catch {
    return
  }
  for (const spec of specs) {
    const [source, destination] = spec.replace(/^\+/, '').split(':')
    if (source === undefined || destination === undefined) {
      continue
    }
    if (source !== 'refs/heads/*' || !destination.startsWith(`refs/remotes/${remote}/`)) {
      continue
    }
    const tracking = destination.replace('*', branch)
    if (!tracking.includes('*')) {
      try {
        execFileSync('git', ['update-ref', tracking, commit], { cwd, stdio: 'ignore' })
      } catch {
        // A read-only or missing tracking ref is not a reason to fail a completed push.
      }
    }
  }
}

/** Run the container's pre-push hook; the host deliberately never runs container-owned hooks. */
function runPrePush(
  path: string,
  remote: string,
  repo: string,
  branch: string,
  commit: string,
  host: string,
  tip: string,
): void {
  const url = `https://${host}/${repo}.git`
  const result = spawnSync(path, [remote, url], {
    cwd: process.cwd(),
    encoding: 'utf8',
    input: `refs/heads/${branch} ${commit} refs/heads/${branch} ${tip}\n`,
  })
  if (result.status !== 0) {
    const reason = (result.stderr || result.stdout || 'pre-push hook refused').trim()
    fail(reason.slice(0, 300))
  }
}

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
  fail('no current branch: pass a branch positional, or check out a branch')
}

/**
 * Parse `gcb push` and submit one host-side push request.
 *
 * @param argv - Arguments after `push`.
 * @returns The process exit code.
 */
/** The normalized argv plus the --as-user spelling it contained. */
export interface AsUserScan {
  readonly argv: readonly string[]
  readonly account?: string
  readonly bare: boolean
}

/** Scan --as-user before parseArgs can consume the following positional as its value. */
export function scanAsUser(argv: readonly string[]): AsUserScan {
  let account: string | undefined
  let bare = false
  const normalized: string[] = []
  for (const argument of argv) {
    if (argument === '--as-user') {
      bare = true
    } else if (argument.startsWith('--as-user=')) {
      if (account !== undefined) {
        fail('--as-user=<login> may only be given once')
      }
      account = argument.slice('--as-user='.length)
    } else {
      normalized.push(argument)
    }
  }
  if (bare && account !== undefined) {
    fail('--as-user cannot be both bare and given a login')
  }
  if (bare || account !== undefined) {
    normalized.push('--as-user')
  }
  return { argv: normalized, account, bare }
}

export async function runPush(argv: readonly string[]): Promise<number> {
  const scan = scanAsUser(argv)
  const { account, bare: bareAsUser } = scan
  const normalized = scan.argv
  const args = parseArgs(normalized, {
    booleans: ['help', 'as-user', 'no-proxy', 'force', 'force-with-lease'],
  })
  if (args.has('help')) {
    say(PUSH_USAGE)
    return 0
  }
  for (const name of args.names) {
    if (!KNOWN_FLAGS.has(name)) {
      fail('unknown option --' + name + ' for gcb push')
    }
  }
  if (account !== undefined && !LOGIN.test(account)) {
    fail(`--as-user must be a GitHub login or no value, got ${JSON.stringify(account)}`)
  }
  if (args.has('force') && args.has('force-with-lease')) {
    fail('--force and --force-with-lease are mutually exclusive')
  }
  const proxyValues = args.values('proxy')
  if (args.has('proxy') && (proxyValues.length === 0 || args.value('proxy') === '')) {
    fail('--proxy needs a value')
  }
  if (args.has('no-proxy') && (args.has('proxy') || proxyValues.length > 0)) {
    fail('--proxy and --no-proxy are mutually exclusive')
  }
  const proxy = args.has('no-proxy') ? null : args.value('proxy')

  if (args.positionals.length > 2) {
    fail('usage: gcb push [<remote> [<branch>]]')
  }
  const remote = args.positionals[0] ?? 'origin'
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) {
    fail(`not a usable remote name: ${JSON.stringify(remote)}`)
  }
  const found = remoteRepo(remote, process.cwd(), true)
  if (found === undefined) {
    fail(
      `remote ${JSON.stringify(remote)} does not name an owner/repository; configure a canonical remote` +
        (bareAsUser && LOGIN.test(remote)
          ? ` (for an account use --as-user=${remote})`
          : ''),
    )
  }
  const repo = `${found.owner}/${found.repo}`
  const host = found.host
  const branch = args.positionals[1] ?? currentBranch()
  if (!BRANCH.test(branch) || branch.includes('..') || branch.includes(':')) {
    fail(`branch is not usable: ${JSON.stringify(branch)}`)
  }
  let commit: string
  try {
    commit = execFileSync(
      'git',
      ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`],
      {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    fail(`cannot resolve ${branch} to a commit`)
  }

  const hook = prePushPath()
  const needsTip = hook !== undefined || args.has('force-with-lease')
  const remoteCommit = needsTip
    ? await readHostTip({
        kind: 'push-tip',
        repo,
        host,
        branch,
        remote,
          session: 'push-tip',
        pid: process.pid,
        ...(account === undefined ? {} : { account }),
        ...(proxy === undefined ? {} : { proxy }),
      })
    : undefined
  const tip = remoteCommit ?? '0'.repeat(commit.length)
  if (hook !== undefined) {
    runPrePush(hook, remote, repo, branch, commit, host, tip)
  }

  const code = await submitToHostBroker(
    {
      kind: 'push',
      repo,
      host,
      branch,
      remote,
      commit,
      ...(args.has('force') ? { force: true } : {}),
      ...(args.has('force-with-lease')
        ? { forceWithLease: true, expected: tip }
        : {}),
      session: 'push',
      pid: process.pid,
      ...(account === undefined ? {} : { account }),
      ...(proxy === undefined ? {} : { proxy }),
    },
    answer =>
      `pushed ${branch} to ${repo}${answer.url === undefined ? '' : `: ${answer.url}`}${account === undefined ? '' : ` as ${account}`}`,
    ANSWER_TIMEOUT_MS,
  )
  if (code === 0) {
    updateTrackingRef(remote, branch, commit, repo)
  }
  return code
}
