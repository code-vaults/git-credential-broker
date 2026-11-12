/**
 * Broker configuration: loaded from a YAML file that lives on the host, outside every mount the
 * agent container can see, and validated eagerly so a broken or over-broad configuration stops the
 * daemon at startup instead of silently denying (or silently allowing) at push time.
 */
import { existsSync, readFileSync } from 'node:fs'
import path, { posix } from 'node:path'

import type {
  ActionPolicy,
  BrokerConfig,
  GithubAppHostConfig,
  HostConfig,
  StaticHostConfig,
} from 'gcb-core'
import { GH_ACTION_NAMES, HOST } from 'gcb-core'
import { parseDocument } from 'yaml'

import { parseAllowEntry } from './policy.ts'

/** The file every command looks for when no configuration path is given. */
export const DEFAULT_CONFIG_FILE = 'broker.config.yml'

/**
 * Where the configuration lives when nothing says otherwise.
 *
 * This convention is what makes the commands usable without repeating paths: run them from the
 * deployment directory and `./broker.config.yml` is found, or export `GIT_BROKER_CONFIG` once. An
 * explicit `--config` always wins.
 *
 * @param explicit - The `--config` argument, if any.
 * @param env - The environment to read.
 * @returns An absolute path.
 */
export function resolveConfigPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(explicit || env['GIT_BROKER_CONFIG'] || DEFAULT_CONFIG_FILE)
}

/**
 * The deployment directory implied by a configuration path.
 *
 * The key, the configuration and the log directory are siblings, so the file's own location says
 * where the deployment is.
 *
 * @param configPath - The configuration path.
 * @returns The absolute directory.
 */
export function deploymentDir(configPath: string): string {
  return path.dirname(path.resolve(configPath))
}

/** The two supported deployments. Which one a configuration suits is decided by its paths. */
export type DeploymentMode = 'host' | 'sidecar'

/**
 * Fixed paths inside the sidecar.
 *
 * A contract with the compose file `compose` prints: it and `init --mode sidecar` both read these
 * from here, because a mismatch is a broker that starts and then cannot find its own key.
 */
/**
 * The file name the authorized person's refresh token is kept under.
 *
 * It sits beside the private key, because the broker reads the key and can find the token without
 * being told anything else — one rule, used by the writer, the reader and the mount, so they cannot
 * drift.
 */
export const USER_TOKEN_FILE = 'user.refresh'

/**
 * Where the authorized person's refresh token is, given the key it sits beside.
 *
 * Posix, not path: these are paths inside the deployment, and the process reading them need not be
 * the platform they belong to.
 *
 * @param privateKeyPath - The key, as the process that reads it sees the path.
 * @returns The refresh token path.
 */
export function userTokenPath(privateKeyPath: string): string {
  return posix.join(posix.dirname(privateKeyPath), USER_TOKEN_FILE)
}

export const SIDECAR = {
  configPath: '/etc/git-cred-broker/config/broker.config.yml',
  keyPath: '/etc/git-cred-broker/app.pem',
  // Beside the key, because that is how the provider derives it without being told.
  // Derived from the key rather than written again: the mount target and the reader's path at once.
  userTokenPath: posix.join(posix.dirname('/etc/git-cred-broker/app.pem'), USER_TOKEN_FILE),
  auditDir: '/var/log/git-cred-broker',
  auditPath: '/var/log/git-cred-broker/audit.jsonl',
  socketDir: '/run/git-broker',
  socketPath: '/run/git-broker/broker.sock',
} as const

/**
 * Which deployment a configuration was written for.
 *
 * Derived from the paths rather than stored, because the paths are what decide whether the broker
 * can find its key. This lives here, not with the CLI, so the daemon can use it to explain a
 * mismatch instead of reporting a bare ENOENT about a path that only exists in the other layout.
 *
 * @param config - A validated configuration.
 * @returns The deployment it suits.
 */
export function inferMode(config: BrokerConfig): DeploymentMode {
  const block = config.hosts['github.com']
  const keyPath = block?.provider === 'github-app' ? block.privateKeyPath : undefined
  return keyPath === SIDECAR.keyPath && config.socketPath === SIDECAR.socketPath
    ? 'sidecar'
    : 'host'
}

/**
 * Check that each recorded private key is readable, before the caller tries to read it.
 *
 * Both the daemon and `diagnose` need this, because both read the key, and a bare `ENOENT ...
 * /etc/git-cred-broker/app.pem` says nothing: that path exists only inside the sidecar, so the
 * mistake is where the command was run, not that the key is missing. The layout is recoverable from
 * the configuration itself, so name it and give the way out.
 *
 * @param config - The validated configuration.
 * @throws {Error} When a key file is missing, with the remedy in the message.
 */

export function assertKeysReadable(config: BrokerConfig): void {
  const mode = inferMode(config)
  for (const [host, block] of Object.entries(config.hosts)) {
    if (block.provider !== 'github-app' || block.privateKeyPath === undefined) {
      continue
    }
    if (existsSync(block.privateKeyPath)) {
      continue
    }

    const remedy =
      mode === 'sidecar'
        ? `${block.privateKeyPath} exists only inside the sidecar container, so this has to run there —\n` +
          '       or against a configuration that records host paths instead:\n' +
          '         gcb init --mode host --socket-path <the path the host process binds>'
        : `${block.privateKeyPath} is the host's path. Install the key there (init does), or if this\n` +
          '       deployment is a sidecar, re-run init with --mode sidecar so the configuration records\n' +
          '       the paths the sidecar actually mounts.'
    throw new Error(`cannot read the private key for ${host}: ${remedy}`)
  }
}

/** Providers this build knows how to construct. */
export const KNOWN_PROVIDERS = ['github-app', 'static'] as const

/**
 * Whether a value is a plain object.
 *
 * @param value - The value to test.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read an optional string field, recording a type error instead of coercing.
 *
 * @param record - The object to read from.
 * @param key - The field name.
 * @param errors - The error accumulator.
 * @param at - The human-readable location, for messages.
 * @returns The string, or undefined when absent or invalid.
 */
function stringField(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  at: string,
): string | undefined {
  const value = record[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    errors.push(`${at}.${key} must be a string`)
    return undefined
  }
  return value
}

/**
 * Read an optional HTTPS URL field.
 *
 * @param record - The object to read from.
 * @param key - The field name.
 * @param errors - The error accumulator.
 * @param at - The configuration path, for the error message.
 * @returns The URL, or undefined when absent or invalid.
 */
function httpsUrlField(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  at: string,
): string | undefined {
  const value = stringField(record, key, errors, at)
  if (value === undefined) {
    return undefined
  }
  try {
    if (new URL(value).protocol === 'https:') {
      return value
    }
  } catch {
    // Fall through to the shared error below.
  }
  errors.push(`${at}.${key} must be an https URL`)
  return undefined
}

/**
 * Read an optional numeric field.
 *
 * @param record - The object to read from.
 * @param key - The field name.
 * @param errors - The error accumulator.
 * @param at - The human-readable location, for messages.
 * @returns The number, or undefined when absent or invalid.
 */
function numberField(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  at: string,
): number | undefined {
  const value = record[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${at}.${key} must be a finite number`)
    return undefined
  }
  return value
}

/**
 * Read an optional boolean field.
 *
 * @param record - The object to read from.
 * @param key - The field name.
 * @param errors - The error accumulator.
 * @param at - The human-readable location, for messages.
 * @returns The boolean, or undefined when absent or invalid.
 */
function booleanField(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  at: string,
): boolean | undefined {
  const value = record[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    errors.push(`${at}.${key} must be a boolean`)
    return undefined
  }
  return value
}

/**
 * Read an optional string-or-number field (the app ID may be written either way).
 *
 * @param record - The object to read from.
 * @param key - The field name.
 * @param errors - The error accumulator.
 * @param at - The human-readable location, for messages.
 * @returns The value, or undefined when absent or invalid.
 */
function stringOrNumberField(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
  at: string,
): string | number | undefined {
  const value = record[key]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value === 'string' || typeof value === 'number') {
    return value
  }
  errors.push(`${at}.${key} must be a string or a number`)
  return undefined
}

/**
 * The same map with its keys lower-cased.
 *
 * These keys are owners, and owners are case-insensitive on GitHub while every comparison in this
 * codebase is made against a lower-cased one. Normalising at the edge is what keeps a configuration
 * that looks right from silently doing nothing.
 *
 * @param value - The map, as written, or nothing when the field is absent.
 * @returns The map with lower-cased keys, or nothing.
 */
function lowerCasedKeys(
  value: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    out[key.toLowerCase()] = entry
  }
  return out
}

/** Validate the SSH account alias map; aliases become URL hosts. */
function sshAccountsField(
  raw: unknown,
  errors: string[],
  at: string,
): Record<string, string> | undefined {
  const map = lowerCasedKeys(stringMapField(raw, errors, at, 'sshAccounts'))
  if (map === undefined) {
    return undefined
  }
  for (const [login, alias] of Object.entries(map)) {
    if (alias.includes(':') || !HOST.test(alias)) {
      errors.push(`${at}.sshAccounts[${JSON.stringify(login)}] is not a usable SSH host`)
    }
  }
  return map
}

/**
 * Read an optional map of strings, for REST permission names.
 *
 * @param value - The raw value.
 * @param errors - The error accumulator.
 * @param at - The human-readable location, for messages.
 * @returns The map, or undefined when absent or invalid.
 */

function stringMapField(
  value: unknown,
  errors: string[],
  at: string,
  field = 'permissions',
): Readonly<Record<string, string>> | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (!isRecord(value)) {
    errors.push(`${at}.${field} must be an object of names to values`)
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      errors.push(`${at}.${field}["${key}"] must be a string`)
      continue
    }
    out[key] = entry
  }
  return out
}

/**
 * Validate a parsed configuration object.
 *
 * @param raw - The parsed JSON.
 * @param source - Where it came from, for error messages.
 * @returns The validated configuration with defaults applied.
 * @throws {Error} When any field is missing or malformed.
 */
export function validateConfig(raw: unknown, source = '<config>'): BrokerConfig {
  if (!isRecord(raw)) {
    throw new Error(`invalid config (${source}): top level must be an object`)
  }

  const errors: string[] = []

  const socketPathRaw = raw['socketPath']
  if (typeof socketPathRaw !== 'string' || !socketPathRaw) {
    errors.push('socketPath is required (absolute path of the broker unix socket)')
  }

  const auditRaw = raw['auditPath']
  if (auditRaw !== undefined && auditRaw !== null && typeof auditRaw !== 'string') {
    errors.push('auditPath must be a string when present')
  }

  const auditMaxRaw = raw['auditMaxBytes']
  if (
    auditMaxRaw !== undefined &&
    (typeof auditMaxRaw !== 'number' || !Number.isInteger(auditMaxRaw) || auditMaxRaw <= 0)
  ) {
    errors.push('auditMaxBytes must be a positive integer')
  }

  const auditKeepRaw = raw['auditKeep']
  if (
    auditKeepRaw !== undefined &&
    (typeof auditKeepRaw !== 'number' || !Number.isInteger(auditKeepRaw) || auditKeepRaw <= 0)
  ) {
    errors.push('auditKeep must be a positive integer')
  }

  const socketModeRaw = raw['socketMode']
  if (socketModeRaw !== undefined && !Number.isInteger(socketModeRaw)) {
    errors.push('socketMode must be an integer (octal literal, e.g. 432 for 0660)')
  }

  const skewRaw = raw['tokenCacheSkewSeconds']
  if (skewRaw !== undefined && (typeof skewRaw !== 'number' || !Number.isFinite(skewRaw))) {
    errors.push('tokenCacheSkewSeconds must be a number')
  }

  const actionsRaw = raw['actions']
  const actions: Record<string, ActionPolicy> = {}
  if (actionsRaw !== undefined) {
    if (isRecord(actionsRaw)) {
      for (const [name, policyRaw] of Object.entries(actionsRaw)) {
        if (!(GH_ACTION_NAMES as readonly string[]).includes(name)) {
          errors.push(`actions[${JSON.stringify(name)}] is not a catalogued action`)
          continue
        }
        if (!isRecord(policyRaw)) {
          errors.push(`actions[${JSON.stringify(name)}] must be an object`)
          continue
        }
        actions[name] = { deny: booleanField(policyRaw, 'deny', errors, `actions[${name}]`) }
      }
    } else {
      errors.push('actions must be an object keyed by catalogued action name')
    }
  }

  const hostsRaw = raw['hosts']
  const hosts: Record<string, HostConfig> = {}
  if (!isRecord(hostsRaw) || Object.keys(hostsRaw).length === 0) {
    errors.push(
      'hosts must be a non-empty object keyed by host as git reports it (e.g. "github.com")',
    )
  } else {
    const seenHosts = new Map<string, string>()
    for (const [host, blockRaw] of Object.entries(hostsRaw)) {
      const at = `hosts["${host}"]`
      const normalizedHost = host.toLowerCase()
      const previousHost = seenHosts.get(normalizedHost)
      if (previousHost !== undefined) {
        errors.push(`${at} duplicates hosts["${previousHost}"] ignoring case`)
        continue
      }
      seenHosts.set(normalizedHost, host)
      if (!isRecord(blockRaw)) {
        errors.push(`${at} must be an object`)
        continue
      }

      const provider = blockRaw['provider']
      if (provider !== 'static' && provider !== 'github-app') {
        errors.push(`${at}.provider must be one of: ${KNOWN_PROVIDERS.join(', ')}`)
        continue
      }

      const allowRaw = blockRaw['allow']
      if (!Array.isArray(allowRaw) || allowRaw.length === 0) {
        errors.push(
          `${at}.allow must be a non-empty array; the broker is default deny, so an empty allowlist is almost certainly a mistake`,
        )
        continue
      }
      const allow: string[] = []
      for (const entry of allowRaw) {
        if (typeof entry !== 'string') {
          errors.push(`${at}.allow must contain only strings`)
          continue
        }
        // A malformed entry would match nothing and therefore deny, which is safe but silent:
        // the operator would believe they had allowed a repository. Reject it loudly instead.
        if (!parseAllowEntry(entry)) {
          errors.push(
            `${at}.allow entry ${JSON.stringify(entry)} is not a valid "owner/repo" pattern ` +
              '(a whole segment may be "*", but a partial wildcard like "wid*" is not)',
          )
          continue
        }
        allow.push(entry)
      }

      if (provider === 'static') {
        const block: StaticHostConfig = {
          provider: 'static',
          allow,
          allowPublicRead: booleanField(blockRaw, 'allowPublicRead', errors, at),
          allowForkPush: booleanField(blockRaw, 'allowForkPush', errors, at),
          allowFork: booleanField(blockRaw, 'allowFork', errors, at),
          sshAccounts: sshAccountsField(blockRaw['sshAccounts'], errors, at),
          username: stringField(blockRaw, 'username', errors, at),
          password: stringField(blockRaw, 'password', errors, at),
          passwordPath: stringField(blockRaw, 'passwordPath', errors, at),
          passwordEnv: stringField(blockRaw, 'passwordEnv', errors, at),
          expiresInSeconds: numberField(blockRaw, 'expiresInSeconds', errors, at),
        }
        hosts[host] = block
      } else {
        const block: GithubAppHostConfig = {
          provider: 'github-app',
          allow,
          allowPublicRead: booleanField(blockRaw, 'allowPublicRead', errors, at),
          allowForkPush: booleanField(blockRaw, 'allowForkPush', errors, at),
          allowFork: booleanField(blockRaw, 'allowFork', errors, at),
          sshAccounts: sshAccountsField(blockRaw['sshAccounts'], errors, at),
          clientId: stringField(blockRaw, 'clientId', errors, at),
          appId: stringOrNumberField(blockRaw, 'appId', errors, at),
          privateKeyPath: stringField(blockRaw, 'privateKeyPath', errors, at),
          privateKeyPem: stringField(blockRaw, 'privateKeyPem', errors, at),
          permissions: stringMapField(blockRaw['permissions'], errors, at),
          apiBaseUrl: httpsUrlField(blockRaw, 'apiBaseUrl', errors, at),
          apiVersion: stringField(blockRaw, 'apiVersion', errors, at),
          installationCacheSeconds: numberField(blockRaw, 'installationCacheSeconds', errors, at),
          verifyAppPermissions: booleanField(blockRaw, 'verifyAppPermissions', errors, at),
        }
        hosts[host] = block
      }
    }
  }

  if (errors.length > 0) {
    const error = new Error(`invalid config (${source}):\n - ${errors.join('\n - ')}`)
    error.name = 'ConfigError'
    throw error
  }

  return {
    socketPath: typeof socketPathRaw === 'string' ? socketPathRaw : '',
    socketMode: typeof socketModeRaw === 'number' ? socketModeRaw : 0o660,
    auditPath: typeof auditRaw === 'string' ? auditRaw : null,
    auditMaxBytes: typeof auditMaxRaw === 'number' ? auditMaxRaw : undefined,
    auditKeep: typeof auditKeepRaw === 'number' ? auditKeepRaw : undefined,
    ...(actionsRaw === undefined ? {} : { actions }),
    tokenCacheSkewSeconds: typeof skewRaw === 'number' ? skewRaw : 300,
    hosts,
  }
}

/** Read configuration text, with the deployment path named on failure. */
export function readConfigText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read config ${path}: ${(error as Error).message}`, { cause: error })
  }
}

/**
 * Read and validate a configuration file.
 *
 * @param path - Path to the YAML config.
 * @returns The validated configuration.
 */
export function loadConfig(path: string): BrokerConfig {
  return loadConfigText(readConfigText(path), path)
}

/** Parse and validate configuration text already read from `path`. */
export function loadConfigText(text: string, path: string): BrokerConfig {
  const document = parseDocument(text, {
    schema: 'core',
    uniqueKeys: true,
    prettyErrors: true,
  })
  if (document.errors.length > 0) {
    throw new Error(
      `config ${path} is not valid YAML: ${document.errors.map(error => error.message).join('; ')}`,
    )
  }
  return validateConfig(document.toJS({ maxAliasCount: 0 }), path)
}
