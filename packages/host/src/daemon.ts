/**
 * Daemon entry point logic: load configuration, build providers, serve the socket.
 *
 * Startup is fail-fast on purpose. A broker that cannot read its private key, or whose
 * configuration is over-broad or malformed, must not come up and quietly serve nothing — an
 * operator has to see the failure. `--check` performs the same validation and provider construction
 * without binding the socket, which is what a deployment script should run before restarting the
 * service.
 */
import { createHash } from 'node:crypto'
import type { Writable } from 'node:stream'

import type { BrokerConfig, Provider } from 'gcb-core'

import { createAudit } from './audit.ts'
import { startBroker } from './broker.ts'
import {
  assertKeysReadable,
  loadConfigText,
  readConfigText,
  resolveConfigPath,
} from './config.ts'
import { createProvider } from './providers/index.ts'
import type { ProviderDeps } from './providers/index.ts'
import { ConfigWatcher } from './reload.ts'

/** Usage text. */
const USAGE =
  'usage: gcb daemon [--config <path>] [--check]\n' +
  '       --config defaults to $GIT_BROKER_CONFIG, then ./broker.config.yml\n' +
  '       --check validates the configuration and the key, then exits without binding the socket'

/** The daemon's parsed command line. */
export interface DaemonArgs {
  readonly configPath: string | undefined
  readonly checkOnly: boolean
  readonly help: boolean
}

/**
 * Parse the daemon's command line.
 *
 * @param argv - Arguments after the script name.
 * @returns The parsed arguments.
 */
export function parseArgs(argv: readonly string[]): DaemonArgs {
  let configPath: string | undefined
  let checkOnly = false
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) {
      continue
    }
    if (argument === '--config') {
      configPath = argv[index + 1]
      index += 1
    } else if (argument.startsWith('--config=')) {
      configPath = argument.slice('--config='.length)
    } else if (argument === '--check') {
      checkOnly = true
    } else if (argument === '--help' || argument === '-h') {
      help = true
    }
  }
  return { configPath, checkOnly, help }
}

/**
 * Build providers for every configured host.
 *
 * @param config - The validated configuration.
 * @param deps - Injectable dependencies, for tests.
 * @returns Host -> provider.
 */
export function buildProviders(
  config: BrokerConfig,
  deps: ProviderDeps = {},
): Map<string, Provider> {
  const providers = new Map<string, Provider>()
  for (const [host, block] of Object.entries(config.hosts)) {
    providers.set(
      host,
      createProvider(host, block, {
        ...deps,
        skewSeconds: deps.skewSeconds ?? config.tokenCacheSkewSeconds,
      }),
    )
  }
  return providers
}

/**
 * Run the daemon.
 *
 * @param argv - Arguments after the script name.
 * @param io - Injectable streams.
 * @returns The process exit code, once the daemon has shut down.
 */
export async function runDaemon(
  argv: readonly string[],
  io: { stderr?: Writable; stdout?: Writable } = {},
): Promise<number> {
  const { stderr = process.stderr, stdout = process.stdout } = io
  const { configPath, checkOnly, help } = parseArgs(argv)
  if (help) {
    stdout.write(`${USAGE}\n`)
    return 0
  }
  // Same convention as the management commands: --config, else GIT_BROKER_CONFIG, else
  // ./broker.config.yml. A wrong pick is loud, because it must load and validate to start at all.
  const resolved = resolveConfigPath(configPath)

  const load = (): { config: BrokerConfig; providers: Map<string, Provider>; digest: string } => {
    const text = readConfigText(resolved)
    const next = loadConfigText(text, resolved)
    assertKeysReadable(next)
    return {
      config: next,
      providers: buildProviders(next, { log: message => stderr.write(`gcb daemon: ${message}\n`) }),
      digest: createHash('sha256').update(text).digest('hex'),
    }
  }
  let config: BrokerConfig
  let providers: Map<string, Provider>
  let initialDigest: string
  try {
    ;({ config, providers, digest: initialDigest } = load())
  } catch (error) {
    stderr.write(`gcb daemon: ${(error as Error).message}\n`)
    return 1
  }

  const summary = [...providers.entries()]
    .map(([host, provider]) => {
      const count = config.hosts[host]?.allow.length ?? 0
      return `${host}(${provider.name}, ${count} allow ${count === 1 ? 'entry' : 'entries'})`
    })
    .join(', ')
  stderr.write(`gcb daemon: config ${resolved} ok: ${summary}\n`)

  if (checkOnly) {
    return 0
  }

  const audit = createAudit({ path: config.auditPath, stderr })
  let broker: Awaited<ReturnType<typeof startBroker>>
  try {
    broker = await startBroker({
      config,
      audit,
      providers,
      log: message => stderr.write(`gcb daemon: ${message}\n`),
    })
  } catch (error) {
    stderr.write(`gcb daemon: cannot start: ${(error as Error).message}\n`)
    return 1
  }

  const active = { config, providers }
  const watcher = new ConfigWatcher({
    file: resolved,
    initialDigest,
    reload: () => {
      const next = load()
      if (next.config.socketPath !== active.config.socketPath) {
        throw new Error('socketPath cannot change without restarting the broker')
      }
      if (next.config.socketMode !== active.config.socketMode) {
        throw new Error('socketMode cannot change without restarting the broker')
      }
      if (next.config.auditPath !== active.config.auditPath) {
        throw new Error('auditPath cannot change without restarting the broker')
      }
      broker.reload(next.config, next.providers)
      active.config = next.config
      active.providers = next.providers
      stderr.write(`gcb daemon: config reloaded\n`)
      audit.record({ event: 'config', decision: 'reload', digest: next.digest })
      return next.digest
    },
    onError: error => {
      stderr.write(`gcb daemon: config reload failed: ${error.message}\n`)
      audit.record({ event: 'config', decision: 'reload-failed', reason: error.message })
    },
  })
  watcher.start()

  await new Promise<void>(resolve => {
    const shutdown = (signal: string): void => {
      stderr.write(`gcb daemon: ${signal} received, shutting down\n`)
      watcher.stop()
      process.off('SIGHUP', onHup)
      broker
        .close()
        .then(() => audit.close())
        .then(() => resolve())
    }
    const onHup = (): void => watcher.check(true)
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    process.once('SIGINT', () => shutdown('SIGINT'))
    process.on('SIGHUP', onHup)
  })
  return 0
}
