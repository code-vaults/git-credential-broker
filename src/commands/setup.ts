/**
 * `setup` — configure the git in *this* environment to use the broker.
 *
 * This is the container-side half, and it replaces the old `container-setup.sh`. It is written
 * to a git config that belongs to the running user, never to a shared repository or to the
 * host's own configuration.
 *
 * It does four things, each for a reason that was measured rather than assumed:
 *  - points `credential.helper` at the installed helper and turns on `credential.useHttpPath`,
 *    without which git sends no repository path and the broker can only authorize host-wide;
 *  - rewrites the ssh remote to https *in this environment only*, because an App installation
 *    token cannot be used over ssh and this container has no ssh key at all;
 *  - supplies a CA bundle when the image has none, because git then cannot verify any TLS
 *    certificate while Node still can — a pair of symptoms that looks like an application bug;
 *  - records the socket path in a file as well as in the environment, because git is often
 *    spawned from a non-login shell that never sources a profile.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { platformRefusal } from '../platform.ts';
import {
  fail,
  findSystemCaBundle,
  gitConfigList,
  gitConfigSet,
  insideMountedPath,
  listFlag,
  mountedPaths,
  parseArgs,
  say,
  warn,
  writeNodeCaBundle,
  writeSecretFile,
} from './support.ts';

/** Everything `setup` needs, resolved. */
export interface SetupInput {
  /** Credential helper command to record. A bare name is resolved by git through PATH. */
  readonly helper: string;
  /** Socket path in this environment. */
  readonly socket: string;
  /** Git config file to write. */
  readonly gitconfig: string;
  /** Shell snippet recording the environment for interactive shells. */
  readonly envFile: string;
  /** Durable socket-path file, read by the helper when the environment carries nothing. */
  readonly socketFile: string;
  /** Where to write a CA bundle when the image has none. */
  readonly caBundlePath: string;
  /** Host whose ssh remotes are rewritten to https, or null to leave remotes alone. */
  readonly rewriteSshHost: string | null;
  /** Report what would happen without writing anything. */
  readonly dryRun: boolean;
  /** Home whose mounts the config must not be written into; defaults to the real home. */
  readonly home?: string;
  /** The directories the container shares, when the caller already has them. */
  readonly mounts?: readonly string[];
  /** Platform to answer for; injectable so the refusal is testable. */
  readonly platform?: NodeJS.Platform;
}

/** What `setup` did. */
export interface SetupResult {
  readonly gitconfig: string;
  readonly entries: readonly string[];
  readonly caBundle: string | null;
  readonly socketFile: string;
  readonly envFile: string;
  readonly warnings: readonly string[];
}

/**
 * The helper path to record when the user did not choose one.
 *
 * The real path of the running script, so the configuration keeps working regardless of PATH —
 * `npx` and global installs both land somewhere git would not otherwise look.
 *
 * A bare path is right because the built entry point carries a shebang and the executable bit. A
 * source checkout has neither, so it has to spell out the interpreter:
 * `git config --global credential.helper '!node /path/src/cli/helper.ts'`.
 *
 * @returns the resolved path, or a bare `git-credential-broker` when it cannot be determined.
 */
export function defaultHelperPath(): string {
  const invoked = process.argv[1];
  if (!invoked) return 'git-credential-broker';
  try {
    return fs.realpathSync(invoked);
  } catch {
    return path.resolve(invoked);
  }
}

/**
 * Apply the configuration.
 *
 * @param input - the resolved options.
 * @returns what was done.
 * @throws {Error} when the target config is a symlink, or inside a directory the container shares.
 */
export async function performSetup(input: SetupInput): Promise<SetupResult> {
  // Refuse on native Windows: configuring git there would look like success and never work, because
  // no Windows process can reach the broker's unix socket.
  const refusal = platformRefusal(input.platform);
  if (refusal !== null) {
    throw new Error(refusal);
  }
  // Writing through a symlink would edit whatever it points at, and a config that lives in a directory
  // the container shares is one the container can rewrite.
  if (fs.existsSync(input.gitconfig) && fs.lstatSync(input.gitconfig).isSymbolicLink()) {
    const target = fs.realpathSync(input.gitconfig);
    throw new Error(`${input.gitconfig} is a symlink to ${target}; refusing to write through it`);
  }
  // The config must not be written into any directory the container can rewrite. Canonical, so the
  // host's spelling of a shared directory and the container's spelling of the same one are one place.
  // `setup` runs in the container by definition, so the mount table it is standing on is the
  // authority. Reading it directly means a container that leaves no marker for `isInsideContainer`
  // (plain containerd, a Kubernetes pod) still gets the right answer instead of hunting for a runtime
  // it does not have.
  const mounts = input.mounts ?? mountedPaths(input.home, { container: true });
  const mounted = insideMountedPath(input.gitconfig, input.home, mounts);
  if (mounted) {
    throw new Error(
      `${input.gitconfig} is inside ${mounted}, which is mounted into the container; refusing to write ` +
        "this environment's git config where the container can rewrite it",
    );
  }

  const warnings: string[] = [];
  if (input.dryRun) {
    return {
      gitconfig: input.gitconfig,
      entries: [
        `credential.helper=${input.helper}`,
        'credential.useHttpPath=true',
        ...(input.rewriteSshHost ? [`url.https://${input.rewriteSshHost}/.insteadOf=git@${input.rewriteSshHost}:`] : []),
      ],
      caBundle: findSystemCaBundle() ? null : input.caBundlePath,
      socketFile: input.socketFile,
      envFile: input.envFile,
      warnings,
    };
  }

  fs.mkdirSync(path.dirname(input.gitconfig), { recursive: true });
  gitConfigSet(input.gitconfig, 'credential.helper', input.helper);
  gitConfigSet(input.gitconfig, 'credential.useHttpPath', 'true');
  if (input.rewriteSshHost) {
    gitConfigSet(
      input.gitconfig,
      `url.https://${input.rewriteSshHost}/.insteadOf`,
      `git@${input.rewriteSshHost}:`,
    );
  }

  // TLS trust. The image may install git with --no-install-recommends and no ca-certificates,
  // in which case every https operation fails with "CAfile: none" while Node keeps working.
  let caBundle: string | null = null;
  const systemBundle = findSystemCaBundle();
  if (systemBundle) {
    say(`TLS            : using the system CA bundle (${systemBundle})`);
  } else {
    const written = await writeNodeCaBundle(input.caBundlePath);
    gitConfigSet(input.gitconfig, 'http.sslCAInfo', input.caBundlePath);
    caBundle = input.caBundlePath;
    say(`TLS            : no system CA bundle; wrote ${written} roots from Node's store`);
    say(`                 ${input.caBundlePath} (adding ca-certificates to the image would be better)`);
  }

  fs.chmodSync(input.gitconfig, 0o600);

  writeSecretFile(
    input.socketFile,
    `${input.socket}\n`,
  );
  writeSecretFile(
    input.envFile,
    [
      '# Generated by git-credential-broker setup',
      `export GIT_BROKER_SOCKET='${input.socket}'`,
      '# Fail closed: if the socket variable ever goes missing, refuse rather than silently',
      '# falling back to whatever other credential the environment happens to offer.',
      'export GIT_BROKER_REQUIRE=1',
      '',
    ].join('\n'),
  );

  if (!fs.existsSync(input.socket)) {
    warnings.push(`no broker socket at ${input.socket} yet; pushes will fail closed until the broker runs`);
  }

  return {
    gitconfig: input.gitconfig,
    entries: gitConfigList(input.gitconfig),
    caBundle,
    socketFile: input.socketFile,
    envFile: input.envFile,
    warnings,
  };
}

/** Usage text for `setup`. */
export const SETUP_USAGE = `Usage: git-credential-broker setup [options]

Configure this environment's git to obtain credentials from the broker.

  --helper <cmd>       Credential helper to record (default: this script's real path)
  --socket <path>      Broker socket path (default: $GIT_BROKER_SOCKET, else /run/git-cred-broker/broker.sock)
  --gitconfig <path>   Git config to write (default: $HOME/.gitconfig)
  --rewrite-ssh <host> Rewrite git@<host>: remotes to https (default: github.com)
  --no-rewrite-ssh     Leave remote URLs alone
  --env-file <path>    Where to record the environment (default: $HOME/.git-broker.env)
  --socket-file <path> Durable socket-path file (default: $HOME/.config/git-credential-broker/socket)
  --ca-bundle <path>   Where to write a CA bundle if the image has none
  --dry-run            Print what would change, write nothing
  -h, --help           Show this help
`;

/**
 * Run the `setup` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code.
 */
export async function runSetup(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['no-rewrite-ssh', 'dry-run', 'help'] });
  if (args.has('help') || args.has('h')) {
    say(SETUP_USAGE);
    return 0;
  }

  const home = os.homedir();
  const socket = args.value('socket') ?? process.env['GIT_BROKER_SOCKET'] ?? '/run/git-cred-broker/broker.sock';
  try {
    const result = await performSetup({
      helper: args.value('helper') ?? defaultHelperPath(),
      socket,
      gitconfig: args.value('gitconfig') ?? path.join(home, '.gitconfig'),
      envFile: args.value('env-file') ?? path.join(home, '.git-broker.env'),
      socketFile: args.value('socket-file') ?? path.join(home, '.config', 'git-credential-broker', 'socket'),
      caBundlePath: args.value('ca-bundle') ?? path.join(home, '.config', 'git-credential-broker', 'ca-bundle.pem'),
      rewriteSshHost: args.has('no-rewrite-ssh') ? null : (args.value('rewrite-ssh') ?? 'github.com'),
      dryRun: args.has('dry-run'),
      home,
    });

    say(`git config     : ${result.gitconfig}${args.has('dry-run') ? ' (dry run)' : ''}`);
    for (const entry of result.entries) say(`  ${entry}`);
    if (result.caBundle) say(`CA bundle      : ${result.caBundle}`);
    say(`socket file    : ${result.socketFile}`);
    say(`env file       : ${result.envFile}`);
    for (const warning of result.warnings) warn(`warning: ${warning}`);
    if (args.has('dry-run')) say('dry run: nothing was written');
    else say('\nnext: start the broker (git-credential-brokerd) and verify with `git-credential-broker probe`.');
    return 0;
  } catch (error) {
    fail((error as Error).message);
  }
}

/**
 * Collect the repeatable `--allow` flag; exported so `init` and tests share one implementation.
 *
 * @param args - the parsed arguments.
 * @returns the entries.
 */
export function allowList(args: ReturnType<typeof parseArgs>): string[] {
  return listFlag(args, 'allow');
}
