/**
 * `init` — create or update the broker configuration, on the host.
 *
 * The configuration file is the source of truth: the daemon only ever reads it, it is meant to
 * be reviewed and kept, and it can be edited by hand. This command therefore **merges** into an
 * existing file instead of rewriting it: only the flags you pass change anything, and anything
 * else — including edits you made yourself — is preserved.
 *
 * That matters most for the allowlist, the thing people actually iterate on. Adding one
 * repository used to mean re-supplying every flag, and `--force` then silently *replaced* the
 * list, so adding `b/two` could quietly drop `a/one`. Now `--allow b/two` adds it and nothing
 * else moves.
 *
 * `--force` still exists, for regenerating from flags when the file is beyond editing.
 */
import fs from 'node:fs';

import { loadConfig, validateConfig } from '../config.ts';
import { parseAllowEntry } from '../policy.ts';
import type { BrokerConfig, GithubAppHostConfig } from '../types.ts';
import {
  brokerPaths,
  DEPLOYMENT_MODES,
  hostArtifacts,
  requireFixedInSidecar,
  SIDECAR,
} from './deployment.ts';
import type { BrokerPaths, DeploymentMode } from './deployment.ts';
import { fail, insideMountedPath, isInsideContainer, parseArgs, say, writeSecretFile } from './support.ts';

/** The environment `init` reasons about, injectable so the guard rails can be tested. */
export interface InitEnvironment {
  /** Whether this process is inside the container. */
  readonly isInsideContainer?: () => boolean;
  /** The home directory whose mounts must not contain the key. */
  readonly home?: string;
}

/** Everything `init` needs, resolved. */
export interface InitInput {
  /** The private key GitHub gave you. Required on the first run; optional afterwards. */
  readonly cert?: string;
  /** Where the key, config and audit log live on the host. Must be outside every container mount. */
  readonly dir: string;
  /** Repositories to ensure are in the allowlist. */
  readonly allow?: readonly string[];
  /** Repositories to remove from the allowlist. */
  readonly removeAllow?: readonly string[];
  /** Replace the allowlist with `allow` instead of adding to it. */
  readonly replaceAllow?: boolean;
  /**
   * Socket path a host process should use. Optional: omitted in sidecar mode, and left as-is in
   * an existing host config unless you pass it. Supplying a conflicting value in sidecar mode is
   * an error rather than ignored.
   */
  readonly hostSocketPath?: string;
  /** Which deployment the recorded paths must suit. Must match an existing config. */
  readonly mode?: DeploymentMode;
  /** App client ID; required on the first run. */
  readonly clientId?: string;
  /** App ID; required on the first run. */
  readonly appId?: number;
  /** Permission map; left as-is unless given. */
  readonly permissions?: Readonly<Record<string, string>>;
  /** Audit log path override, `host` mode only. */
  readonly auditPath?: string;
  /** Regenerate from these flags, discarding the existing file. */
  readonly force: boolean;
  /** Injectable environment; defaults to the real one. */
  readonly env?: InitEnvironment;
}

/** What `init` produced. */
export interface InitResult {
  /** Host path of the installed key. */
  readonly keyPath: string;
  /** Host path of the written config. */
  readonly configPath: string;
  readonly config: BrokerConfig;
  readonly mode: DeploymentMode;
  /** The configuration that was replaced, when this was an update. */
  readonly previous?: BrokerConfig;
}

/**
 * The github-app block of a configuration.
 *
 * @param config - a validated configuration.
 * @returns the block for github.com.
 * @throws {Error} when there is none, which means the file is not one of ours.
 */
export function appBlock(config: BrokerConfig): GithubAppHostConfig {
  const block = config.hosts['github.com'];
  if (block?.provider !== 'github-app') {
    throw new Error('the configuration has no github-app block for github.com');
  }
  return block;
}

/**
 * Which deployment an existing configuration was written for.
 *
 * Derived from its paths rather than stored, because the paths are what actually decide whether
 * a sidecar can find its key.
 *
 * @param config - a validated configuration.
 * @returns the deployment it suits.
 */
export function inferMode(config: BrokerConfig): DeploymentMode {
  const block = config.hosts['github.com'];
  const keyPath = block?.provider === 'github-app' ? block.privateKeyPath : undefined;
  return keyPath === SIDECAR.keyPath && config.socketPath === SIDECAR.socketPath ? 'sidecar' : 'host';
}

/**
 * Compute the new allowlist from the existing one and the flags given.
 *
 * @param existing - the current entries.
 * @param input - the resolved options.
 * @returns the new entries, order preserved, additions deduplicated case-insensitively.
 * @throws {Error} when a given entry is malformed.
 */
export function mergeAllowList(existing: readonly string[], input: InitInput): string[] {
  const additions = input.allow ?? [];
  for (const entry of [...additions, ...(input.removeAllow ?? [])]) {
    if (!parseAllowEntry(entry)) {
      throw new Error(
        `--allow ${JSON.stringify(entry)} is not a valid "owner/repo" pattern (a whole segment may be "*")`,
      );
    }
  }

  const result = input.replaceAllow
    ? [...additions]
    : (() => {
        const removed = new Set((input.removeAllow ?? []).map((entry) => entry.toLowerCase()));
        const kept = existing.filter((entry) => !removed.has(entry.toLowerCase()));
        const seen = new Set(kept.map((entry) => entry.toLowerCase()));
        for (const entry of additions) {
          const key = entry.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          kept.push(entry);
        }
        return kept;
      })();

  if (result.length === 0) {
    throw new Error(
      'that would leave the allowlist empty; the broker is default-deny, so there would be nothing it could authorize',
    );
  }
  return result;
}

/**
 * Build a fresh configuration from the flags.
 *
 * @param input - the resolved options.
 * @returns the validated configuration.
 * @throws {Error} when the configuration would be rejected by the daemon.
 */
export function buildBrokerConfig(input: InitInput): BrokerConfig {
  const paths = brokerPaths(input.mode ?? 'host', input.dir, input.hostSocketPath);
  return validateConfig({
    socketPath: paths.socketPath,
    auditPath: input.auditPath ?? paths.auditPath,
    hosts: {
      'github.com': {
        provider: 'github-app',
        allow: [...(input.allow ?? [])],
        clientId: input.clientId,
        appId: input.appId,
        privateKeyPath: paths.privateKeyPath,
        permissions: input.permissions,
      } satisfies GithubAppHostConfig,
    },
  });
}

/**
 * Merge the flags into an existing configuration, changing only what was asked for.
 *
 * @param existing - the configuration on disk.
 * @param input - the resolved options.
 * @param paths - the paths the broker will resolve; taken from the existing file where the flags
 *   say nothing.
 * @returns the validated configuration to write.
 * @throws {Error} when the result would be rejected by the daemon.
 */
export function mergeBrokerConfig(existing: BrokerConfig, input: InitInput, paths: BrokerPaths): BrokerConfig {
  const block = appBlock(existing);
  return validateConfig({
    socketPath: paths.socketPath,
    auditPath: input.auditPath ?? existing.auditPath,
    hosts: {
      'github.com': {
        provider: 'github-app',
        allow: mergeAllowList(block.allow, input),
        clientId: input.clientId ?? block.clientId,
        appId: input.appId ?? block.appId,
        privateKeyPath: paths.privateKeyPath,
        permissions: input.permissions ?? block.permissions,
      } satisfies GithubAppHostConfig,
    },
  });
}

/**
 * Read and validate an existing configuration.
 *
 * @param path - the config file.
 * @returns the configuration, or null when the file does not exist.
 * @throws {Error} when the file exists but is not a valid configuration.
 */
function readExistingConfig(path: string): BrokerConfig | null {
  if (!fs.existsSync(path)) return null;
  return loadConfig(path);
}

/**
 * Install the key and create or update the configuration.
 *
 * @param input - the resolved options.
 * @returns where things landed.
 * @throws {Error} for any guard-rail violation.
 */
export function performInit(input: InitInput): InitResult {
  if (input.mode !== undefined && !DEPLOYMENT_MODES.includes(input.mode)) {
    throw new Error(`--mode must be one of ${DEPLOYMENT_MODES.join(', ')}; got ${input.mode}`);
  }

  const insideContainer = (input.env?.isInsideContainer ?? isInsideContainer)();
  if (insideContainer) {
    throw new Error('this looks like the agent container; the broker must run outside it, on the host');
  }

  const home = input.env?.home ?? (process.env['HOME'] ?? '');
  const mounted = insideMountedPath(input.dir, home);
  if (mounted) {
    throw new Error(
      `${input.dir} is inside ${mounted}, which is mounted into the container; the private key must live outside every mount`,
    );
  }

  const artifacts = hostArtifacts(input.dir);
  const previous = input.force ? null : readExistingConfig(artifacts.configPath);

  // ---------------------------------------------------------------- update in place
  if (previous) {
    const mode = inferMode(previous);
    if (input.mode !== undefined && input.mode !== mode) {
      throw new Error(
        `${artifacts.configPath} was written for --mode ${mode} and its paths say so; re-running with --mode ${input.mode} would re-point them. Pass --force to regenerate it, or keep --mode ${mode}.`,
      );
    }
    requireFixedInSidecar('--socket-path', input.hostSocketPath, SIDECAR.socketPath, mode);
    requireFixedInSidecar('--audit-path', input.auditPath, SIDECAR.auditPath, mode);

    // The key the *host* must have is always <dir>/app.pem. In sidecar mode the config records a
    // different path, because that is where the sidecar sees the same file — checking the
    // recorded path here would fail on every update.
    if (input.cert !== undefined) {
      writeSecretFile(artifacts.keyPath, readPrivateKey(input.cert));
    } else if (!fs.existsSync(artifacts.keyPath)) {
      throw new Error(`${artifacts.keyPath} is missing; pass --cert to install the key`);
    }

    const paths: BrokerPaths =
      mode === 'sidecar'
        ? brokerPaths('sidecar', input.dir, '')
        : {
            socketPath: input.hostSocketPath ?? previous.socketPath,
            privateKeyPath: artifacts.keyPath,
            auditPath: input.auditPath ?? previous.auditPath ?? '',
          };

    const config = mergeBrokerConfig(previous, input, paths);
    fs.mkdirSync(artifacts.auditDir, { recursive: true });
    writeSecretFile(artifacts.configPath, `${JSON.stringify(config, null, 2)}\n`);
    return { keyPath: artifacts.keyPath, configPath: artifacts.configPath, config, mode, previous };
  }

  // ---------------------------------------------------------------- create (or regenerate)
  const mode = input.mode ?? 'host';
  const allow = input.allow ?? [];
  if (allow.length === 0) {
    throw new Error(
      'at least one --allow <owner/repo> is required when creating the configuration (the broker is default-deny)',
    );
  }
  for (const entry of allow) {
    if (!parseAllowEntry(entry)) {
      throw new Error(
        `--allow ${JSON.stringify(entry)} is not a valid "owner/repo" pattern (a whole segment may be "*")`,
      );
    }
  }
  // Captured into locals: narrowing of `input.x` is invalidated by the calls in between, so
  // reading the property again afterwards is `string | undefined` to the compiler.
  const certPath = input.cert;
  const clientId = input.clientId;
  const appId = input.appId;
  if (certPath === undefined) throw new Error('--cert is required when creating the configuration');
  if (clientId === undefined || clientId === '') {
    throw new Error('--client-id is required when creating the configuration');
  }
  if (appId === undefined || appId <= 0) {
    throw new Error('--app-id is required when creating the configuration');
  }

  requireFixedInSidecar('--socket-path', input.hostSocketPath, SIDECAR.socketPath, mode);
  requireFixedInSidecar('--audit-path', input.auditPath, SIDECAR.auditPath, mode);

  const pem = readPrivateKey(certPath);
  const config = buildBrokerConfig({ ...input, mode, cert: certPath, clientId, appId });
  writeSecretFile(artifacts.keyPath, pem);
  fs.mkdirSync(artifacts.auditDir, { recursive: true });
  writeSecretFile(artifacts.configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { keyPath: artifacts.keyPath, configPath: artifacts.configPath, config, mode };
}

/**
 * Read and sanity-check a PEM private key.
 *
 * @param cert - the path GitHub gave you.
 * @returns the file contents.
 * @throws {Error} when it is missing or is not a PEM private key.
 */
function readPrivateKey(cert: string): string {
  if (!fs.existsSync(cert)) throw new Error(`no such file: ${cert}`);
  const pem = fs.readFileSync(cert, 'utf8');
  if (!pem.includes('PRIVATE KEY')) throw new Error(`${cert} does not look like a PEM private key`);
  return pem;
}

/** Usage text for `init`. */
export const INIT_USAGE = `Usage: git-credential-broker init [options]

Create or update the broker configuration. Run this on the HOST.

The configuration file is the source of truth. Re-running init updates it in place and changes
only what you pass, so hand edits survive and the allowlist is never silently replaced.

First run:
  --cert <path>         GitHub App private key (.pem)                    [required]
  --allow <owner/repo>  Repository to authorize; repeatable or comma-separated  [required]
  --client-id <id>      App client ID (preferred JWT issuer)             [required]
  --app-id <id>         App ID (fallback issuer)                         [required]

Every run:
  --allow <owner/repo>  Add to the allowlist (deduplicated); repeatable or comma-separated
  --remove-allow <r>    Remove from the allowlist; repeatable or comma-separated
  --replace-allow       Replace the whole allowlist with --allow, instead of adding
  --cert <path>         Replace the installed key
  --client-id <id>      Change the client ID
  --app-id <id>         Change the App ID
  --permissions <list>  name=level pairs, e.g. contents=write,pull_requests=write
  --dir <path>          Where the key, config and audit log live (default: /volume1/docker/git-cred-broker)
  --mode <host|sidecar> Which deployment the paths must suit (default: host; must match an
                        existing config, because it decides where the broker looks for things)
  --socket-path <path>  Socket path a host process uses (default: /run/git-cred-broker/broker.sock)
  --audit-path <path>   Audit log path override (host mode only)
  --force               Regenerate from these flags, discarding the existing file
  -h, --help            Show this help

--mode matters because the paths inside the configuration are resolved by the broker process,
not by this one. In --mode sidecar they are fixed by the compose file (socketPath
${SIDECAR.socketPath}, privateKeyPath ${SIDECAR.keyPath}, auditPath ${SIDECAR.auditPath}),
so a different --socket-path or --audit-path is rejected rather than silently recorded.
`;

/**
 * Parse `--permissions contents=write,pull_requests=write`.
 *
 * @param raw - the raw flag value, if any.
 * @returns the permission map, or undefined when the flag was not given.
 * @throws {Error} when an entry is not `name=level`.
 */
export function parsePermissions(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) throw new Error(`--permissions expects name=level pairs, got ${JSON.stringify(trimmed)}`);
    out[trimmed.slice(0, equals)] = trimmed.slice(equals + 1);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Split a repeatable, comma-separated flag.
 *
 * @param args - the parsed arguments.
 * @param name - the flag name.
 * @returns the entries.
 */
function list(args: ReturnType<typeof parseArgs>, name: string): string[] {
  return args
    .values(name)
    .flatMap((value) => value.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Run the `init` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code.
 */
export async function runInit(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['force', 'replace-allow', 'help'] });
  if (args.has('help') || args.has('h')) {
    say(INIT_USAGE);
    return 0;
  }

  const clientId = args.value('client-id');
  const appIdRaw = args.value('app-id');
  const appId = appIdRaw === undefined ? undefined : Number(appIdRaw);
  if (appId !== undefined && (!Number.isInteger(appId) || appId <= 0)) {
    fail('--app-id must be a positive integer');
  }
  const mode = args.value('mode');
  if (mode !== undefined && !DEPLOYMENT_MODES.includes(mode as DeploymentMode)) {
    fail(`--mode must be one of ${DEPLOYMENT_MODES.join(', ')}`);
  }

  const dir = args.value('dir') ?? '/volume1/docker/git-cred-broker';
  try {
    const result = performInit({
      cert: args.value('cert'),
      dir,
      allow: list(args, 'allow'),
      removeAllow: list(args, 'remove-allow'),
      replaceAllow: args.has('replace-allow'),
      hostSocketPath: args.value('socket-path'),
      mode: mode as DeploymentMode | undefined,
      clientId,
      appId,
      permissions: parsePermissions(args.value('permissions')),
      auditPath: args.value('audit-path'),
      force: args.has('force'),
    });

    const verb = result.previous ? 'updated' : 'created';
    say(`mode           : ${result.mode}`);
    say(`${verb.padEnd(15)}: ${result.configPath} (mode 600, validation passed)`);
    say(`installed key  : ${result.keyPath} (mode 600)`);

    const block = appBlock(result.config);
    if (result.previous) {
      const beforeBlock = appBlock(result.previous);
      say('');
      say(`allowlist      : ${beforeBlock.allow.join(' ')}`);
      say(`              -> ${block.allow.join(' ')}`);
      const changed = (['clientId', 'appId', 'permissions'] as const).filter(
        (key) => JSON.stringify(beforeBlock[key]) !== JSON.stringify(block[key]),
      );
      if (changed.length > 0) say(`also changed   : ${changed.join(', ')}`);
    } else {
      say(`allowlist      : ${block.allow.join(' ')}`);
    }

    say('');
    say('paths inside the configuration, from the broker\'s point of view:');
    say(`  socketPath     : ${result.config.socketPath}`);
    say(
      `  privateKeyPath : ${block.privateKeyPath}${block.privateKeyPath === result.keyPath ? '' : `  (= ${result.keyPath} on the host)`}`,
    );
    say(`  auditPath      : ${result.config.auditPath}`);
    say('');
    if (result.previous) {
      say('Restart the broker to pick this up:');
      say('  docker compose -f docker-compose.broker.yml restart    # sidecar');
      say(`  git-credential-brokerd --config ${result.configPath}    # host process`);
    } else {
      say('Two things only you can do:');
      say('  1. Install the app on the account that owns those repositories, granting access to just them.');
      say('     A private app owned by an organisation can only be installed on that organisation.');
      say('  2. Confirm the app grants every permission requested above; the broker checks on first use.');
      say('');
      if (result.mode === 'sidecar') {
        say('Then start the sidecar, which mounts those paths exactly as recorded:');
        say(`  git-credential-broker compose --dir ${dir} --socket-dir <a directory the pusher mounts> \\`);
        say('    > docker-compose.broker.yml && docker compose -f docker-compose.broker.yml up -d');
      } else {
        say('Then start the broker as a host process:');
        say(`  git-credential-brokerd --config ${result.configPath} --check   # validate, bind nothing`);
        say(`  git-credential-brokerd --config ${result.configPath}`);
      }
    }
    return 0;
  } catch (error) {
    fail((error as Error).message);
  }
}
