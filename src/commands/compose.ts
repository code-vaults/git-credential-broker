/**
 * `compose` — print a Docker sidecar definition for the broker.
 *
 * Replaces the old `deploy-sidecar.sh` compose generation. The broker runs in its own container
 * with the private key mounted read-only, no ports, no capabilities and a read-only root
 * filesystem; the only surface it shares with anything else is the socket directory.
 *
 * The container fetches the package itself, so there is no checkout to copy and nothing to
 * build on the host — which is the point of publishing this to npm.
 */
import { packageVersion } from '../version.ts';
import { fail, parseArgs, say } from './support.ts';

/** Everything `compose` needs, resolved. */
export interface ComposeInput {
  /** Host directory holding config.json, app.pem and log/. */
  readonly dir: string;
  /** Host directory the DSH container already mounts, where the socket will appear. */
  readonly socketDir: string;
  /** `uid:gid` the sidecar runs as; must match the container that needs the socket. */
  readonly user: string;
  /** Socket path inside the sidecar. Must match the config's `socketPath`. */
  readonly socketPath: string;
  /** Base image. */
  readonly image: string;
  /** npm spec to run, e.g. `git-credential-broker@0.1.0`. */
  readonly packageSpec: string;
  /** Compose service and container name. */
  readonly name: string;
}

/**
 * Render the compose file.
 *
 * @param input - the resolved options.
 * @returns the YAML, newline-terminated.
 */
export function renderCompose(input: ComposeInput): string {
  const socketDir = input.socketDir.replace(/\/+$/, '');
  return `# Docker sidecar for git-credential-broker@${packageVersion()}
#
# The broker holds the only long-lived secret, so it runs isolated: the key is mounted
# read-only, there are no published ports, no capabilities, and the root filesystem is
# read-only. The socket directory is the only thing shared with the container that pushes.
#
#   docker compose -f <this file> up -d
#
# The image installs the package on start. If you would rather not depend on the registry at
# boot, build a two-line image instead:
#
#   FROM ${input.image}
#   RUN npm install -g ${input.packageSpec}
#
# and replace \`command\` below with:
#   ["git-credential-brokerd", "--config", "/etc/git-cred-broker/config.json"]
services:
  ${input.name}:
    image: ${input.image}
    container_name: ${input.name}
    restart: unless-stopped
    user: "${input.user}"
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    environment:
      # npx needs somewhere writable for its cache; /tmp is a tmpfs above.
      - npm_config_cache=/tmp/npm-cache
    command:
      - sh
      - -c
      - exec npx --yes --package '${input.packageSpec}' git-credential-brokerd --config /etc/git-cred-broker/config.json
    volumes:
      - ${input.dir}/config.json:/etc/git-cred-broker/config.json:ro
      - ${input.dir}/app.pem:/etc/git-cred-broker/app.pem:ro
      - ${input.dir}/log:/var/log/git-cred-broker
      - ${socketDir}:/run/git-broker
# The socket lands at ${socketDir}${input.socketPath.replace('/run/git-broker', '')} on the host, and the config expects it at
# ${input.socketPath} inside the sidecar. Point the pushing environment at the same socket with:
#   git-credential-broker setup --socket <that path as the pusher sees it>
`;
}

/** Usage text for `compose`. */
export const COMPOSE_USAGE = `Usage: git-credential-broker compose [options]

Print a Docker sidecar definition for the broker (to stdout).

  --dir <path>        Host directory holding config.json, app.pem and log/
  --socket-dir <path> Host directory the pushing container already mounts
  --user <uid:gid>    UID the sidecar runs as (default: this user)
  --socket <path>     Socket path inside the sidecar (default: /run/git-broker/broker.sock)
  --image <name>      Base image (default: node:24-slim)
  --package <spec>    npm spec to run (default: git-credential-broker@<version>)
  --name <name>       Service and container name (default: git-cred-broker)
  -h, --help          Show this help
`;

/**
 * Run the `compose` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code.
 */
export function runCompose(argv: readonly string[]): number {
  const args = parseArgs(argv, { booleans: ['help'] });
  if (args.has('help') || args.has('h')) {
    say(COMPOSE_USAGE);
    return 0;
  }

  const dir = args.value('dir');
  const socketDir = args.value('socket-dir');
  if (!dir) fail('--dir is required (where init put config.json and app.pem)');
  if (!socketDir) {
    fail('--socket-dir is required (a host directory the pushing container already mounts, e.g. its ~/.dsh)');
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;

  say(
    renderCompose({
      dir,
      socketDir,
      user: args.value('user') ?? (uid !== undefined && gid !== undefined ? `${uid}:${gid}` : '1000:1000'),
      socketPath: args.value('socket') ?? '/run/git-broker/broker.sock',
      image: args.value('image') ?? 'node:24-slim',
      packageSpec: args.value('package') ?? `git-credential-broker@${packageVersion()}`,
      name: args.value('name') ?? 'git-cred-broker',
    }),
  );
  return 0;
}
