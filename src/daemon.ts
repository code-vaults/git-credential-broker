/**
 * Daemon entry point logic: load configuration, build providers, serve the socket.
 *
 * Startup is fail-fast on purpose. A broker that cannot read its private key, or whose
 * configuration is over-broad or malformed, must not come up and quietly serve nothing — an
 * operator has to see the failure. `--check` performs the same validation and provider
 * construction without binding the socket, which is what a deployment script should run
 * before restarting the service.
 */
import { existsSync } from 'node:fs';
import type { Writable } from 'node:stream';

import { createAudit } from './audit.ts';
import { startBroker } from './broker.ts';
import { inferMode, loadConfig, resolveConfigPath } from './config.ts';
import { createProvider } from './providers/index.ts';
import type { ProviderDeps } from './providers/index.ts';
import type { BrokerConfig, Provider } from './types.ts';

/** Usage text. */
const USAGE =
  'usage: git-credential-brokerd [--config <path>] [--check]\n' +
  '       --config defaults to $GIT_BROKER_CONFIG, then ./broker.config.json\n' +
  '       --check validates the configuration and the key, then exits without binding the socket';

/** The daemon's parsed command line. */
export interface DaemonArgs {
  readonly configPath: string | undefined;
  readonly checkOnly: boolean;
  readonly help: boolean;
}

/**
 * Parse the daemon's command line.
 *
 * @param argv - arguments after the script name.
 * @returns the parsed arguments.
 */
export function parseArgs(argv: readonly string[]): DaemonArgs {
  let configPath: string | undefined;
  let checkOnly = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === '--config') {
      configPath = argv[index + 1];
      index += 1;
    } else if (argument.startsWith('--config=')) {
      configPath = argument.slice('--config='.length);
    } else if (argument === '--check') {
      checkOnly = true;
    } else if (argument === '--help' || argument === '-h') {
      help = true;
    }
  }
  return { configPath, checkOnly, help };
}

/**
 * Build providers for every configured host.
 *
 * @param config - the validated configuration.
 * @param deps - injectable dependencies, for tests.
 * @returns host -> provider.
 */
export function buildProviders(config: BrokerConfig, deps: ProviderDeps = {}): Map<string, Provider> {
  const providers = new Map<string, Provider>();
  for (const [host, block] of Object.entries(config.hosts)) {
    providers.set(
      host,
      createProvider(host, block, {
        ...deps,
        skewSeconds: deps.skewSeconds ?? config.tokenCacheSkewSeconds,
      }),
    );
  }
  return providers;
}

/**
 * Check that each recorded private key is readable, before the providers try to read it.
 *
 * A bare `ENOENT ... /etc/git-cred-broker/app.pem` on a host is unhelpful: that path only exists
 * inside the sidecar container, and nothing in the message says so. The layout is recoverable from
 * the configuration itself, so name it and give the way out.
 *
 * @param config - the validated configuration.
 * @throws {Error} when a key file is missing, with the remedy in the message.
 */
export function assertKeysReadable(config: BrokerConfig): void {
  const mode = inferMode(config);
  for (const [host, block] of Object.entries(config.hosts)) {
    if (block.provider !== 'github-app' || block.privateKeyPath === undefined) continue;
    if (existsSync(block.privateKeyPath)) continue;

    const remedy =
      mode === 'sidecar'
        ? `${block.privateKeyPath} exists only inside the sidecar container.\n` +
          '       Either start the sidecar with the key mounted there, or run the broker as a host\n' +
          '       process, which records host paths instead:\n' +
          '         git-credential-broker init --mode host --socket-path <the path the host process binds>'
        : `${block.privateKeyPath} is the host's path. Install the key there (init does), or if this\n` +
          '       deployment is a sidecar, re-run init with --mode sidecar so the config records the\n' +
          '       paths the sidecar actually mounts.';
    throw new Error(`cannot read the private key for ${host}: ${remedy}`);
  }
}

/**
 * Run the daemon.
 *
 * @param argv - arguments after the script name.
 * @param io - injectable streams.
 * @returns the process exit code, once the daemon has shut down.
 */
export async function runDaemon(
  argv: readonly string[],
  io: { stderr?: Writable; stdout?: Writable } = {},
): Promise<number> {
  const { stderr = process.stderr, stdout = process.stdout } = io;
  const { configPath, checkOnly, help } = parseArgs(argv);
  if (help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  // Same convention as the management commands: --config, else GIT_BROKER_CONFIG, else
  // ./broker.config.json. A wrong pick is loud, because it must load and validate to start at all.
  const resolved = resolveConfigPath(configPath);

  let config: BrokerConfig;
  let providers: Map<string, Provider>;
  try {
    config = loadConfig(resolved);
    assertKeysReadable(config);
    providers = buildProviders(config);
  } catch (error) {
    stderr.write(`git-credential-brokerd: ${(error as Error).message}\n`);
    return 1;
  }

  const summary = [...providers.entries()]
    .map(([host, provider]) => {
      const count = config.hosts[host]?.allow.length ?? 0;
      return `${host}(${provider.name}, ${count} allow ${count === 1 ? 'entry' : 'entries'})`;
    })
    .join(', ');
  stderr.write(`git-credential-brokerd: config ${resolved} ok: ${summary}\n`);

  if (checkOnly) return 0;

  const audit = createAudit({ path: config.auditPath, stderr });
  let broker: Awaited<ReturnType<typeof startBroker>>;
  try {
    broker = await startBroker({
      config,
      audit,
      providers,
      log: (message) => stderr.write(`git-credential-brokerd: ${message}\n`),
    });
  } catch (error) {
    stderr.write(`git-credential-brokerd: cannot start: ${(error as Error).message}\n`);
    return 1;
  }

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string): void => {
      stderr.write(`git-credential-brokerd: ${signal} received, shutting down\n`);
      broker
        .close()
        .then(() => audit.close())
        .then(() => resolve());
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });
  return 0;
}
