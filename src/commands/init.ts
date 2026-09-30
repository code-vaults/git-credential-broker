/**
 * `init` — install the App private key and write the broker configuration, on the host.
 *
 * It refuses to run inside the container, refuses to put the key anywhere the container can
 * read, and validates the configuration through the same code the daemon uses, so a mistake is
 * caught here rather than at the first push.
 *
 * `--mode` decides which set of paths goes *into* the file, because the broker resolves them
 * from its own filesystem view: a host process reads the host's paths, a sidecar reads the paths
 * its `volumes:` mount at. See `deployment.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';

import { validateConfig } from '../config.ts';
import { parseAllowEntry } from '../policy.ts';
import type { BrokerConfig, GithubAppHostConfig } from '../types.ts';
import {
  brokerPaths,
  DEPLOYMENT_MODES,
  hostArtifacts,
  requireFixedInSidecar,
  SIDECAR,
} from './deployment.ts';
import type { DeploymentMode } from './deployment.ts';
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
  /** The private key GitHub gave you. */
  readonly cert: string;
  /** Where the key, config and audit log live on the host. Must be outside every container mount. */
  readonly dir: string;
  /** Default-deny allowlist. */
  readonly allow: readonly string[];
  /**
   * Socket path a host process should use. Optional: omitted in sidecar mode, and defaulted in
   * host mode. Supplying a conflicting value in sidecar mode is an error rather than ignored.
   */
  readonly hostSocketPath?: string;
  /** Which deployment the recorded paths must suit. */
  readonly mode?: DeploymentMode;
  readonly clientId: string;
  readonly appId: number;
  readonly permissions: Readonly<Record<string, string>>;
  /** Audit log path override, `host` mode only. */
  readonly auditPath?: string;
  /** Overwrite an existing config. */
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
}

/**
 * Build and validate the broker configuration object.
 *
 * @param input - the resolved options.
 * @returns the validated configuration.
 * @throws {Error} when the configuration would be rejected by the daemon.
 */
export function buildBrokerConfig(input: InitInput): BrokerConfig {
  const mode = input.mode ?? 'host';
  const paths = brokerPaths(mode, input.dir, input.hostSocketPath);

  const host: GithubAppHostConfig = {
    provider: 'github-app',
    allow: [...input.allow],
    clientId: input.clientId,
    appId: input.appId,
    privateKeyPath: paths.privateKeyPath,
    permissions: input.permissions,
  };

  // Round-trip through the daemon's own validator: one source of truth for what is acceptable.
  return validateConfig({
    socketPath: paths.socketPath,
    auditPath: input.auditPath ?? paths.auditPath,
    hosts: { 'github.com': host },
  });
}

/**
 * Install the key and write the configuration.
 *
 * @param input - the resolved options.
 * @returns where things landed.
 * @throws {Error} for any guard-rail violation.
 */
export function performInit(input: InitInput): InitResult {
  const mode = input.mode ?? 'host';
  if (!DEPLOYMENT_MODES.includes(mode)) {
    throw new Error(`--mode must be one of ${DEPLOYMENT_MODES.join(', ')}; got ${mode}`);
  }

  const insideContainer = (input.env?.isInsideContainer ?? isInsideContainer)();
  if (insideContainer) {
    throw new Error('this looks like the agent container; the broker must run outside it, on the host');
  }

  const home = input.env?.home ?? os.homedir();
  const mounted = insideMountedPath(input.dir, home);
  if (mounted) {
    throw new Error(
      `${input.dir} is inside ${mounted}, which is mounted into the container; the private key must live outside every mount`,
    );
  }

  if (!fs.existsSync(input.cert)) throw new Error(`no such file: ${input.cert}`);
  const pem = fs.readFileSync(input.cert, 'utf8');
  if (!pem.includes('PRIVATE KEY')) throw new Error(`${input.cert} does not look like a PEM private key`);

  if (input.allow.length === 0) {
    throw new Error('at least one --allow <owner>/<repo> is required (the broker is default-deny)');
  }
  for (const entry of input.allow) {
    if (!parseAllowEntry(entry)) {
      throw new Error(
        `--allow ${JSON.stringify(entry)} is not a valid "owner/repo" pattern (a whole segment may be "*")`,
      );
    }
  }

  // The compose file decides these in sidecar mode, so a conflicting flag must not be ignored.
  requireFixedInSidecar('--socket-path', input.hostSocketPath, SIDECAR.socketPath, mode);
  requireFixedInSidecar('--audit-path', input.auditPath, SIDECAR.auditPath, mode);

  const artifacts = hostArtifacts(input.dir);
  if (fs.existsSync(artifacts.configPath) && !input.force) {
    throw new Error(`${artifacts.configPath} already exists; pass --force to overwrite it`);
  }

  const config = buildBrokerConfig(input);

  writeSecretFile(artifacts.keyPath, pem);
  fs.mkdirSync(artifacts.auditDir, { recursive: true });
  writeSecretFile(artifacts.configPath, `${JSON.stringify(config, null, 2)}\n`);

  return { keyPath: artifacts.keyPath, configPath: artifacts.configPath, config, mode };
}

/** Usage text for `init`. */
export const INIT_USAGE = `Usage: git-credential-broker init [options]

Install an App private key and write the broker configuration. Run this on the HOST.

  --cert <path>         GitHub App private key (.pem)                  [required]
  --allow <owner/repo>  Repository to authorize; repeatable or comma-separated  [required]
  --client-id <id>      App client ID (preferred JWT issuer)           [required]
  --app-id <id>         App ID (fallback issuer)
  --mode <host|sidecar> Which deployment the recorded paths must suit (default: host)
  --dir <path>          Where the key, config and audit log live (default: /volume1/docker/git-cred-broker)
  --socket-path <path>  Socket path a host process uses (default: /run/git-cred-broker/broker.sock)
  --permissions <list>  name=level pairs (default: contents=write)
  --audit-path <path>   Audit log path override (host mode only)
  --force               Overwrite an existing config.json
  -h, --help            Show this help

--mode matters because the paths inside config.json are resolved by the broker process, not by
this one. In --mode sidecar they are fixed by the compose file (socketPath ${SIDECAR.socketPath},
privateKeyPath ${SIDECAR.keyPath}, auditPath ${SIDECAR.auditPath}), so a different
--socket-path or --audit-path is rejected rather than silently recorded.
`;

/**
 * Parse `--permissions contents=write,pull_requests=write`.
 *
 * @param raw - the raw flag value, if any.
 * @returns the permission map.
 * @throws {Error} when an entry is not `name=level`.
 */
export function parsePermissions(raw: string | undefined): Record<string, string> {
  if (!raw) return { contents: 'write' };
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) throw new Error(`--permissions expects name=level pairs, got ${JSON.stringify(trimmed)}`);
    out[trimmed.slice(0, equals)] = trimmed.slice(equals + 1);
  }
  return Object.keys(out).length > 0 ? out : { contents: 'write' };
}

/**
 * Run the `init` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code.
 */
export async function runInit(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['force', 'help'] });
  if (args.has('help') || args.has('h')) {
    say(INIT_USAGE);
    return 0;
  }

  const allow = args
    .values('allow')
    .flatMap((value) => value.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const cert = args.value('cert');
  const clientId = args.value('client-id');
  if (!cert) fail('--cert is required (the .pem GitHub gave you)');
  if (!clientId) fail('--client-id is required (App settings page)');
  const appId = Number(args.value('app-id') ?? '0');
  if (!Number.isInteger(appId) || appId <= 0) fail('--app-id must be a positive integer');

  const mode = (args.value('mode') ?? 'host') as DeploymentMode;
  if (!DEPLOYMENT_MODES.includes(mode)) fail(`--mode must be one of ${DEPLOYMENT_MODES.join(', ')}`);

  const dir = args.value('dir') ?? '/volume1/docker/git-cred-broker';
  try {
    const result = performInit({
      cert,
      dir,
      allow,
      hostSocketPath: args.value('socket-path'),
      mode,
      clientId,
      appId,
      permissions: parsePermissions(args.value('permissions')),
      auditPath: args.value('audit-path'),
      force: args.has('force'),
    });

    const paths = brokerPaths(result.mode, dir, args.value('socket-path'));
    say(`mode           : ${result.mode} (paths recorded as the broker will see them)`);
    say(`installed key  : ${result.keyPath} (mode 600)`);
    say(`wrote config   : ${result.configPath} (mode 600, validation passed)`);
    say(`allowed repos  : ${allow.join(' ')}`);
    say('');
    say('paths inside config.json, from the broker\'s point of view:');
    say(`  socketPath     : ${paths.socketPath}`);
    say(
      `  privateKeyPath : ${paths.privateKeyPath}${paths.privateKeyPath === result.keyPath ? '' : `  (= ${result.keyPath} on the host)`}`,
    );
    say(`  auditPath      : ${paths.auditPath}`);
    say('');
    say('Two things only you can do:');
    say('  1. Install the app on the account that owns those repositories, granting access to just them.');
    say('     A private app owned by an organisation can only be installed on that organisation.');
    say('  2. Confirm the app grants every permission requested above; the broker checks on first use.');
    say('');
    if (result.mode === 'sidecar') {
      say('Then start the sidecar, which mounts those paths exactly as recorded:');
      say('  git-credential-broker compose --dir ' + dir + ' --socket-dir <a directory the pusher mounts> \\');
      say('    > docker-compose.broker.yml && docker compose -f docker-compose.broker.yml up -d');
      say('');
      say('Re-running `compose` keeps these paths in sync; that is why both derive from one definition.');
    } else {
      say('Then start the broker as a host process:');
      say(`  git-credential-brokerd --config ${result.configPath} --check   # validate, bind nothing`);
      say(`  git-credential-brokerd --config ${result.configPath}`);
      say('');
      say('For a sidecar instead, re-run with --mode sidecar so the recorded paths match its mounts.');
    }
    say('');
    say('Inside the container, point git at the same socket:');
    say('  git-credential-broker setup --socket <the socket path as the container sees it>');
    return 0;
  } catch (error) {
    fail((error as Error).message);
  }
}
