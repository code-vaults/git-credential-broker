/**
 * `init` — install the App private key and write the broker configuration, on the host.
 *
 * Replaces the old `host-setup.sh`. It refuses to run inside the container, refuses to put the
 * key anywhere the container can read, and validates the configuration through the same code
 * the daemon uses, so a mistake is caught here rather than at the first push.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateConfig } from '../config.ts';
import { parseAllowEntry } from '../policy.ts';
import type { BrokerConfig, GithubAppHostConfig } from '../types.ts';
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
  /** Where the key, config and audit log live. Must be outside every container mount. */
  readonly dir: string;
  /** Default-deny allowlist. */
  readonly allow: readonly string[];
  /** Socket path *as the broker process sees it*. */
  readonly socketPath: string;
  readonly clientId: string;
  readonly appId: number;
  readonly permissions: Readonly<Record<string, string>>;
  /** Audit log path, as the broker process sees it. */
  readonly auditPath?: string;
  /** Overwrite an existing config. */
  readonly force: boolean;
  /** Injectable environment; defaults to the real one. */
  readonly env?: InitEnvironment;
}

/** What `init` produced. */
export interface InitResult {
  readonly keyPath: string;
  readonly configPath: string;
  readonly config: BrokerConfig;
}

/**
 * Build and validate the broker configuration object.
 *
 * @param input - the resolved options.
 * @returns the validated configuration.
 * @throws {Error} when the configuration would be rejected by the daemon.
 */
export function buildBrokerConfig(input: InitInput): BrokerConfig {
  const host: GithubAppHostConfig = {
    provider: 'github-app',
    allow: [...input.allow],
    clientId: input.clientId,
    appId: input.appId,
    privateKeyPath: path.join(input.dir, 'app.pem'),
    permissions: input.permissions,
  };
  // Round-trip through the daemon's own validator: one source of truth for what is acceptable.
  return validateConfig({
    socketPath: input.socketPath,
    auditPath: input.auditPath ?? path.join(input.dir, 'log', 'audit.jsonl'),
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

  const configPath = path.join(input.dir, 'config.json');
  if (fs.existsSync(configPath) && !input.force) {
    throw new Error(`${configPath} already exists; pass --force to overwrite it`);
  }

  const config = buildBrokerConfig(input);

  const keyPath = path.join(input.dir, 'app.pem');
  writeSecretFile(keyPath, pem);
  fs.mkdirSync(path.dirname(config.auditPath ?? path.join(input.dir, 'log', 'audit.jsonl')), { recursive: true });
  writeSecretFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return { keyPath, configPath, config };
}

/** Usage text for `init`. */
export const INIT_USAGE = `Usage: git-credential-broker init [options]

Install an App private key and write the broker configuration. Run this on the HOST.

  --cert <path>         GitHub App private key (.pem)                  [required]
  --allow <owner/repo>  Repository to authorize; repeatable or comma-separated  [required]
  --client-id <id>      App client ID (preferred JWT issuer)           [required]
  --app-id <id>         App ID (fallback issuer)
  --dir <path>          Where the key, config and audit log live (default: /volume1/docker/git-cred-broker)
  --socket-path <path>  Socket path as the broker sees it (default: /run/git-broker/broker.sock)
  --permissions <list>  name=level pairs (default: contents=write)
  --audit-path <path>   Audit log path as the broker sees it
  --force               Overwrite an existing config.json
  -h, --help            Show this help

Add --compose to also print a Docker sidecar definition for this deployment.
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
  const args = parseArgs(argv, { booleans: ['force', 'compose', 'help'] });
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

  const dir = args.value('dir') ?? '/volume1/docker/git-cred-broker';
  try {
    const result = performInit({
      cert,
      dir,
      allow,
      socketPath: args.value('socket-path') ?? '/run/git-broker/broker.sock',
      clientId,
      appId,
      permissions: parsePermissions(args.value('permissions')),
      auditPath: args.value('audit-path'),
      force: args.has('force'),
    });

    say(`installed key  : ${result.keyPath} (mode 600)`);
    say(`wrote config   : ${result.configPath} (mode 600, validation passed)`);
    say(`allowed repos  : ${allow.join(' ')}`);
    say('');
    say('Two things only you can do:');
    say('  1. Install the app on the account that owns those repositories, granting access to just them.');
    say('     A private app owned by an organisation can only be installed on that organisation.');
    say('  2. Confirm the app grants every permission requested above; the broker checks on first use.');
    say('');
    say('Then start the broker. Either as a sidecar:');
    say(`  git-credential-broker compose --dir ${dir} --socket-dir <a directory the container can see>`);
    say('or as a host process:');
    say(`  git-credential-brokerd --config ${result.configPath}`);
    say('');
    say('Inside the container, point git at the same socket:');
    say('  git-credential-broker setup --socket <the socket path as the container sees it>');
    return 0;
  } catch (error) {
    fail((error as Error).message);
  }
}
