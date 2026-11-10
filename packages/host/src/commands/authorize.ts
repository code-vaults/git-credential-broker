/**
 * `authorize` — get a user token for this app, once, from whoever runs it.
 *
 * Run on the host, beside the configuration. It prints a code, waits for that person to type it at
 * GitHub on whatever device has a browser, and stores the refresh token next to the configuration
 * and its key — outside every mount, never in the repository. From then on the broker renews the
 * token by itself and nothing here has to be run again.
 *
 * The token is what makes a pull request authored by a person rather than by the app. Only a person
 * can be the author of one that reviewers will not skip, and only the device flow reaches a person
 * whose host has no browser and no callback server.
 *
 * Exit codes: 0 stored, 1 refused.
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  rmSync,
  openSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'

import { fail, insideMountedPath, isInsideContainer, parseArgs, say, warn } from 'gcb-core'

import { USER_TOKEN_FILE, userTokenPath, loadConfig, resolveConfigPath } from '../config.ts'
import { collectUserToken, startDeviceFlow, type Fetcher } from '../device-flow.ts'
import { fetcherFor, parseProxy } from '../http.ts'

/** Usage text for `authorize`. */
export const AUTHORIZE_USAGE = `Usage: gcb authorize [options]

Get a user token for this app, by authorizing it once from a browser somewhere else. Run it on the host,
beside the configuration. It stores a refresh token and prints where; nothing else needs running after
that, because the broker renews the token itself.

  --config <path>      The configuration (default: $GIT_BROKER_CONFIG, else ./broker.config.yml)
  --host <host>        The host block to authorize for (default: github.com)
  --to <path>          Where to write the refresh token (default: beside the configuration)
  --broker-container   Allow a target inside the broker container's mounts; only when it is not
                       shared with the agent container
  --proxy <url>        Use this proxy for this command
  --no-proxy           Reach GitHub directly for this command
  -h, --help           Show this help

The app needs its client id configured (the App ID will not do), and "Enable Device Flow" selected in
its settings. GitHub returns a refresh token only while "Expire user authorization tokens" is selected,
which is its default and what this wants.
`

/**
 * Where this command writes the refresh token.
 *
 * Beside the configuration, because the configuration is the path this process was _given_: the
 * paths inside it belong to whichever process runs the broker, and for a sidecar those are
 * container paths that do not exist out here. In the usual sidecar layout the configuration and the
 * key sit in one directory, so this lands in the same file the broker reads; where they differ, the
 * difference is printed rather than discovered later.
 *
 * @param configPath - The resolved configuration path.
 * @returns The path to write the refresh token to.
 */
export function refreshTokenPath(configPath: string): string {
  return join(dirname(resolvePath(configPath)), USER_TOKEN_FILE)
}

/**
 * Where the broker will look for it, which is beside the key — from the key's own point of view.
 *
 * @param privateKeyPath - The path as the configuration records it.
 * @returns The path the broker reads, or `undefined` when the key is not a file.
 */
export function brokerReadsPath(privateKeyPath: string | undefined): string | undefined {
  return privateKeyPath === undefined ? undefined : userTokenPath(privateKeyPath)
}

/** Inputs for the credential-placement decision. */
export interface AuthorizationPlacementInput {
  readonly configPath: string
  readonly to?: string
  readonly brokerContainer: boolean
  readonly isInsideContainer?: () => boolean
  readonly mountedPath?: (target: string) => string | null
}

/** The writable target and the warning to print before starting the device flow. */
export interface AuthorizationPlacement {
  readonly target: string
  readonly warning?: string
}

/** A token descriptor and whether this attempt created the file. */
export interface OpenedTokenTarget {
  readonly fd: number
  readonly created: boolean
}

/**
 * Open and secure the token target before authorization, so a later path swap cannot redirect the
 * write and a permission failure surfaces before the device flow.
 *
 * @param target - The token path.
 * @returns The open descriptor, its creation state, and mode 0600.
 */
export function openTokenTarget(target: string): OpenedTokenTarget {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  const flags = constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  let fd: number
  let created = false
  try {
    fd = openSync(target, flags | constants.O_EXCL, 0o600)
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    fd = openSync(target, flags, 0o600)
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) {
      throw new Error(`${target} is not a regular file`)
    }
    const uid = process.geteuid?.()
    if (uid !== undefined && info.uid !== uid) {
      throw new Error(`${target} is not owned by the current user`)
    }
    fchmodSync(fd, 0o600)
    return { fd, created }
  } catch (error) {
    closeSync(fd)
    if (created) {
      try {
        rmSync(target, { force: true })
      } catch {
        // Best effort: the open/validation error is the message that matters.
      }
    }
    throw error
  }
}

/** Write the refresh token through the descriptor opened before the device flow. */
function writeToken(fd: number, token: string): void {
  ftruncateSync(fd, 0)
  writeFileSync(fd, `${token}\n`)
  // ACL-based shares can ignore the create/open mode; set it again after the write.
  fchmodSync(fd, 0o600)
}

/**
 * Decide where the refresh token goes, and whether that placement is allowed.
 *
 * @param input - The configuration path, target override and injectable guards.
 * @returns The target and an optional warning.
 * @throws {Error} When the placement would put the token inside a container mount without the
 * explicit broker-container acknowledgement.
 */
export function resolveAuthorizationPlacement(
  input: AuthorizationPlacementInput,
): AuthorizationPlacement {
  const target = input.to ?? refreshTokenPath(input.configPath)
  if ((input.isInsideContainer ?? isInsideContainer)()) {
    throw new Error(
      'run this on the host, not inside the container: the token must not land anywhere the container can read',
    )
  }
  if (input.brokerContainer) {
    return {
      target,
      warning:
        "writing inside the broker container's mounts; this is only safe when the target is not shared with the agent container",
    }
  }
  const mounted = (input.mountedPath ?? insideMountedPath)(target)
  if (mounted !== null) {
    throw new Error(
      `${target} is inside ${mounted}, which is mounted into the container; the refresh token must live\n` +
        '  outside every mount — the deployment directory beside the configuration is the usual place',
    )
  }
  return { target }
}

/**
 * Run the `authorize` command.
 *
 * @param argv - Arguments after the command name.
 * @returns The process exit code: 0 stored, 1 refused.
 */
import { assertProxyEnabled } from '../proxy.ts'

export async function runAuthorize(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['broker-container', 'help', 'no-proxy'] })
  if (args.has('no-proxy') && args.value('proxy') !== undefined) {
    fail('--proxy and --no-proxy are mutually exclusive')
  }
  if (args.has('proxy') && args.value('proxy') === undefined) {
    fail('--proxy needs a value')
  }
  const proxy = args.has('no-proxy') ? null : args.value('proxy')
  if (proxy !== undefined && parseProxy(proxy) === false) {
    fail('--proxy must be an http(s) URL')
  }
  if (args.has('help') || args.has('h')) {
    say(AUTHORIZE_USAGE)
    return 0
  }

  if (proxy === undefined) {
    assertProxyEnabled()
  }
  const configPath = resolveConfigPath(args.value('config'))
  const host = args.value('host') ?? 'github.com'
  const config = loadConfig(configPath)
  const block = config.hosts[host]
  if (block === undefined) {
    fail(`no host ${host} in ${configPath}`)
  }
  if (block.provider !== 'github-app') {
    fail(`${host} is not a github-app host`)
  }
  if (block.clientId === undefined) {
    fail(
      `${host} has no clientId — a device flow needs the app's client id, and the App ID will not do`,
    )
  }

  let placement: AuthorizationPlacement
  try {
    placement = resolveAuthorizationPlacement({
      configPath,
      to: args.value('to'),
      brokerContainer: args.has('broker-container'),
    })
  } catch (error) {
    fail((error as Error).message)
  }
  if (placement.warning !== undefined) {
    warn(placement.warning)
  }
  say(`the refresh token will be written to ${placement.target}`)

  let opened: OpenedTokenTarget
  try {
    opened = openTokenTarget(placement.target)
  } catch (error) {
    fail(`could not open ${placement.target}: ${(error as Error).message}`)
  }
  const tokenFd = opened.fd
  let failure: Error | undefined
  try {
    const fetcher: Fetcher = fetcherFor(proxy)
    const code = await startDeviceFlow(block.clientId, fetcher)
    say(`Open ${code.verificationUri} and enter: ${code.userCode}`)
    say(`Waiting up to ${Math.round(code.expiresIn / 60)} minutes for that to be authorized…`)

    const token = await collectUserToken(
      block.clientId,
      code,
      fetcher,
      ms => new Promise(done => setTimeout(done, ms)),
    )
    if (token.refreshToken === undefined) {
      throw new Error(
        'GitHub returned no refresh token, so the token would expire in eight hours with no way to renew.\n' +
          '  Select "Expire user authorization tokens" in the app settings and authorize again.',
      )
    }
    writeToken(tokenFd, token.refreshToken)
  } catch (error) {
    failure = error as Error
  } finally {
    closeSync(tokenFd)
  }
  if (failure !== undefined) {
    if (opened.created) {
      try {
        rmSync(placement.target, { force: true })
      } catch {
        // Best effort: the authorization failure is the message that matters.
      }
    }
    fail(failure.message)
  }
  say(`stored the refresh token in ${placement.target} (mode 600)`)
  const readByBroker = brokerReadsPath(block.privateKeyPath)
  if (readByBroker === undefined) {
    // An inline privateKeyPem deployment: the broker has no directory to derive a path from, so it never
    // looks for this file. Saying otherwise would be a promise the broker does not keep.
    say(
      'note: this host block keeps its key inline, so the broker has nowhere to look for this file:',
    )
    say('      pull requests will stay app-authored until the key is a file (privateKeyPath)')
  } else if (resolvePath(readByBroker) === resolvePath(placement.target)) {
    say(
      'which is where the broker looks for it — keep it writable, since the token is rotated on every use',
    )
  } else {
    say(
      `note: the broker will look in ${readByBroker} — make sure that is this file, and that it is`,
    )
    say('      writable, because GitHub rotates the token on every exchange')
  }
  say(
    'the broker will use it for pull requests authored by that person; nothing else needs running',
  )
  return 0
}


