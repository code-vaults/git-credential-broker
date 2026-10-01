/**
 * `compose` — print a Docker sidecar definition for the broker.
 *
 * The broker runs in its own container with the private key mounted read-only, no published
 * ports, no capabilities and a read-only root filesystem; the only surface it shares with
 * anything else is the socket directory. The container fetches the published package, so there
 * is no checkout to copy and nothing to build on the host.
 *
 * The mount targets are constants from `deployment.ts`, shared with `init --mode sidecar`, so
 * the paths recorded in `broker.config.json` and the paths this file mounts cannot drift apart.
 */
import fs from 'node:fs';

import { inferMode, loadConfig, resolveConfigPath, deploymentDir, SIDECAR } from '../config.ts';
import { platformRefusal } from '../platform.ts';
import { packageVersion } from '../version.ts';
import { fail, parseArgs, say, warn } from './support.ts';

/** Everything `compose` needs, resolved. */
export interface ComposeInput {
  /** Host directory holding broker.config.json, app.pem and log/. */
  readonly dir: string;
  /** Host directory the pushing container already mounts, where the socket will appear. */
  readonly socketDir: string;
  /** `uid:gid` the sidecar runs as; must match the container that needs the socket. */
  readonly user: string;
  /** Base image. */
  readonly image: string;
  /** npm spec to run, e.g. `git-credential-broker@0.1.0`. */
  readonly packageSpec: string;
  /** Compose service and container name. */
  readonly name: string;
  /**
   * Host directory holding the broker's code, as `stage` exports it. When given, the sidecar runs
   * that code with the image's Node instead of fetching the package at start: no registry access
   * at boot, and the commit that runs is the one you reviewed.
   */
  readonly code?: string;
}

/** Where a code-mounted sidecar expects the broker. */
export const CODE_DIR = '/opt/git-credential-broker';

/**
 * Render the compose file.
 *
 * @param input - the resolved options.
 * @returns the YAML, newline-terminated.
 */
export function renderCompose(input: ComposeInput): string {
  const socketDir = input.socketDir.replace(/\/+$/, '');
  const fromCode = input.code !== undefined;

  const origin = fromCode
    ? `# It runs the code mounted read-only from ${input.code}, which is whatever \`stage\` put there —
# see the STAGED.json beside it for the commit. Nothing is fetched at start and nothing is built:
# Node 24 strips TypeScript types, so src/cli/daemon.ts runs as it is.`
    : `# The image fetches the published package at start:
#
#   npx --yes --package '${input.packageSpec}' git-credential-brokerd
#
# To avoid depending on the registry at boot, either render this file with --code <directory> to
# run staged code from a mount, or point --image at an image of your own that already has the
# package installed, and change \`command\` to the binary in it:
#   ["git-credential-brokerd", "--config", "${SIDECAR.configPath}"]`;

  const environment = fromCode
    ? ''
    : `
    environment:
      # npx needs somewhere writable for its cache; /tmp is a tmpfs above.
      - npm_config_cache=/tmp/npm-cache`;

  const command = fromCode
    ? `      - node
      - ${CODE_DIR}/src/cli/daemon.ts
      - --config
      - ${SIDECAR.configPath}`
    : `      - sh
      - -c
      - exec npx --yes --package '${input.packageSpec}' git-credential-brokerd --config ${SIDECAR.configPath}`;

  const codeMount = fromCode
    ? `
      # The code, read-only, from the commit you reviewed and staged.
      - ${input.code}:${CODE_DIR}:ro`
    : '';

  return `# Docker sidecar for git-credential-broker@${packageVersion()}
#
# The broker holds the only long-lived secret, so it runs isolated: the key is mounted
# read-only, there are no published ports, no capabilities, and the root filesystem is
# read-only. The socket directory is the only thing shared with the container that pushes.
#
#   docker compose -f <this file> up -d
#
${origin}
#
# IMPORTANT: this file fixes where the sidecar sees things, so broker.config.json must have been
# written for it. Create it with:
#
#   git-credential-broker init --mode sidecar --cert <key.pem> --allow <owner/repo> \\
#     --client-id <id> --app-id <id> --dir ${input.dir}
#
# which records exactly these paths (both commands read them from one definition):
#
#   socketPath     ${SIDECAR.socketPath}
#   privateKeyPath ${SIDECAR.keyPath}
#   auditPath      ${SIDECAR.auditPath}
#
# A config written with --mode host records host paths and the sidecar will not start.
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
      - no-new-privileges:true${environment}
    # Egress. The socket needs no proxy; the broker's calls to api.github.com and github.com do. Node's
    # fetch ignores http_proxy, so a deployment behind one has to pass them here.
    environment:
      - http_proxy=\${http_proxy:-}
      - https_proxy=\${https_proxy:-}
      - no_proxy=\${no_proxy:-}
    command:
${command}
    volumes:${codeMount}
      - ${input.dir}/broker.config.json:${SIDECAR.configPath}:ro
      - ${input.dir}/app.pem:${SIDECAR.keyPath}:ro
      # The authorized person's refresh token: the only secret mounted writable, because GitHub
      # rotates it on every exchange. The authorize command creates it; create it before the first
      # up, since a bind mount for a path that does not exist becomes a directory.
      - ${input.dir}/user.refresh:${SIDECAR.userTokenPath}:rw
      - ${input.dir}/log:${SIDECAR.auditDir}
      - ${socketDir}:${SIDECAR.socketDir}
# The socket appears at ${socketDir}${SIDECAR.socketPath.slice(SIDECAR.socketDir.length)} on the host. Point the pushing
# environment at the same socket with:
#   git-credential-broker setup --socket <that path as the pusher sees it>
`;
}

/** Usage text for `compose`. */
export const COMPOSE_USAGE = `Usage: git-credential-broker compose [options]

Print a Docker sidecar definition for the broker (to stdout). Pair it with a config written by
\`init --mode sidecar\`, whose paths this file fixes.

  --dir <path>        Host directory holding broker.config.json, app.pem and log/ (default: the config's directory)
  --config <path>     The sidecar's config, checked before anything is printed
                      (default: $GIT_BROKER_CONFIG, else ./broker.config.json)
  --socket-dir <path> Host directory the pushing container already mounts
  --code <path>       Run code mounted from this host directory instead of fetching the package
                      at start (as \`stage\` exports it); nothing is fetched or built at boot
  --user <uid:gid>    UID the sidecar runs as (default: this user)
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
  // Refused rather than printed wrong: the file binds host paths and a socket directory, so a
  // version rendered on Windows would either not resolve or put the socket somewhere it cannot live.
  const refusal = platformRefusal();
  if (refusal !== null) {
    fail(refusal);
  }

  const configPath = resolveConfigPath(args.value('config'));
  const socketDir = args.value('socket-dir');
  if (!socketDir) {
    fail('--socket-dir is required (a host directory the pushing container already mounts, e.g. its ~/.dsh)');
  }
  const dir = args.value('dir') ?? deploymentDir(configPath);

  // Check before emitting. A config written for the other deployment produces a sidecar that
  // starts and then cannot find its own private key, which is a confusing way to find out.
  if (fs.existsSync(configPath)) {
    const mode = inferMode(loadConfig(configPath));
    if (mode !== 'sidecar') {
      fail(
        `${configPath} was written with --mode host; re-run ` +
          '`git-credential-broker init --mode sidecar ...` before using compose',
      );
    }
  } else {
    warn(`no configuration at ${configPath} yet; create it with \`init --mode sidecar\` first`);
  }

  // POSIX only, and guaranteed to exist by the refusal above: the file this prints binds host paths
  // and a socket directory, neither of which works from a Windows host. Asserting it here rather
  // than defaulting to a made-up uid — a wrong `user:` line is a silent misconfiguration.
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    fail('compose needs a POSIX uid and gid');
  }
  const user = args.value('user') ?? `${uid}:${gid}`;

  say(
    renderCompose({
      dir,
      socketDir,
      user,
      image: args.value('image') ?? 'node:24-slim',
      packageSpec: args.value('package') ?? `git-credential-broker@${packageVersion()}`,
      name: args.value('name') ?? 'git-cred-broker',
      code: args.value('code'),
    }),
  );
  return 0;
}
