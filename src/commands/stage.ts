/**
 * `stage` — export the broker from a reviewed commit into the directory it will run from.
 *
 * Why this exists: the broker must read the App private key, so whatever code it executes has that
 * key's privileges. It can mint installation tokens for anything the App can see, and it can read
 * the key file itself. Keeping the *key* outside every container mount is necessary but not
 * sufficient: if the code comes from a directory the agent can write, then the agent decides what
 * the broker does — and the broker is the process holding the key. The boundary that matters is
 * control of the code, not the location of the key.
 *
 * So: export from a **commit** (not from the working tree, which is agent-writable and may be
 * dirty), into a directory outside every mount, and record what was exported next to it, so
 * "which code is running with my key?" has an answer.
 *
 * What this does not do is make the repository trustworthy. The same agent can rewrite commits, so
 * the sha being staged is printed for you to check against a clone or the remote. Stage a sha you
 * have looked at, not merely whatever HEAD happens to be.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalPath } from '../paths.ts';
import { fail, insideMountedPath, parseArgs, say, warn, writeSecretFile } from './support.ts';

/** The record `stage` leaves behind, so the running code is identifiable afterwards. */
export const STAGED_RECORD = 'STAGED.json';

/** Everything `stage` needs, resolved. */
export interface StageInput {
  /** The repository to export from. */
  readonly repo: string;
  /** Where the broker will run from. Must be outside every container mount. */
  readonly to: string;
  /** The commit to export. A commit, never the working tree. */
  readonly ref: string;
  /** The home whose mounts the target must not be inside. */
  readonly home?: string;
  /** The directories the container shares, when the caller already has them. */
  readonly mounts?: readonly string[];
  /** Replace a target that this command did not stage itself. */
  readonly force?: boolean;
  /**
   * Install the staged commit's locked dependencies before bundling. Defaults to true; tests and
   * preinstalled toolchains may turn it off, but a deployment build should always install.
   */
  readonly installDependencies?: boolean;
}

/** What `stage` produced. */
export interface StageResult {
  readonly to: string;
  readonly sha: string;
  readonly subject: string;
  readonly files: number;
  /** Uncommitted changes existed and are therefore *not* part of what was staged. */
  readonly dirtyWorkingTree: boolean;
  /** SHA-256 of the self-contained bundles built from the commit. */
  readonly bundles: { readonly gcb: string; readonly daemon: string };
}

/**
 * Export a commit into the directory the broker will run from.
 *
 * @param input - the resolved options.
 * @returns what was staged.
 * @throws {Error} for any guard-rail violation.
 */
export function performStage(input: StageInput): StageResult {
  const repo = path.resolve(input.repo);
  const to = path.resolve(input.to);
  const home = input.home ?? process.env['HOME'] ?? '';

  const mounted = insideMountedPath(to, home, input.mounts);
  if (mounted) {
    throw new Error(
      `${to} is inside ${mounted}, which is mounted into the container. The broker runs with the ` +
        'private key in reach, so code there is code the agent can rewrite — stage outside every mount.',
    );
  }
  // Canonical, for the same reason the mount check is: a `--to` that is a symlink into the repository
  // *is* the repository, and comparing the spellings would miss it.
  const realRepo = canonicalPath(repo);
  const realTo = canonicalPath(to);
  if (
    realTo === realRepo ||
    realTo.startsWith(realRepo + path.sep) ||
    realRepo.startsWith(realTo + path.sep)
  ) {
    throw new Error(`refusing to stage ${repo} into ${to}: the repository and the target overlap`);
  }

  // The deployment directory holds the key and the configuration. A `--to` typo pointing at it
  // would replace both, so refuse before anything is removed.
  const deploymentFiles = ['app.pem', 'broker.config.toml', 'broker.config.json', 'log'].filter((name) =>
    fs.existsSync(path.join(to, name)),
  );
  if (deploymentFiles.length > 0) {
    throw new Error(
      `${to} looks like the deployment directory itself, not a place for code: it holds ` +
        `${deploymentFiles.join(', ')}. Stage into a subdirectory of it, for example ${path.join(to, 'app')}.`,
    );
  }

  const recordName = STAGED_RECORD;
  const entries = fs.existsSync(to) ? fs.readdirSync(to) : [];
  if (entries.length > 0 && !fs.existsSync(path.join(to, recordName)) && input.force !== true) {
    throw new Error(
      `${to} is not empty and does not carry a ${recordName} from a previous run, so it is not ` +
        'ours to clear. Remove it yourself, or pass --force to replace its contents.',
    );
  }

  const git = (args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): string => {
    const result = spawnSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ...extraEnv },
    });
    if (result.status !== 0) {
      throw new Error(
        `git ${args.join(' ')} failed: ${(result.stderr ?? '').trim() || `exit ${String(result.status)}`}`,
      );
    }
    return (result.stdout ?? '').trim();
  };

  const sha = git(['rev-parse', '--verify', `${input.ref}^{commit}`]);
  const subject = git(['log', '-1', '--format=%s', sha]);
  const dirtyWorkingTree = git(['status', '--porcelain']).length > 0;
  const files = git(['ls-tree', '-r', '--name-only', sha])
    .split('\n')
    .filter((line) => line.length > 0).length;

  // Build beside the destination and swap only after everything succeeded. A failed install or
  // bundle must leave the previous stage — and the daemon that may be running from it — untouched.
  const parent = path.dirname(to);
  const temp = path.join(parent, `.${path.basename(to)}.tmp-${process.pid}-${Date.now()}`);
  const old = path.join(parent, `.${path.basename(to)}.old-${process.pid}-${Date.now()}`);
  let tempExists = false;
  let oldExists = false;
  try {
    fs.mkdirSync(temp, { recursive: true, mode: 0o755 });
    tempExists = true;

    // Exported with git alone. `git archive | tar` would add a dependency on a system `tar`, which is
    // not a given on Windows, and there is no need for one: a temporary index can address the commit
    // and `checkout-index` writes it out. The prefix is given with forward slashes because that is
    // what git accepts on every platform.
    const indexFile = path.join(os.tmpdir(), `git-credential-broker-stage-${process.pid}-${Date.now()}`);
    const prefix = `${temp.replace(/\\/g, '/')}/`;
    try {
      git(['read-tree', sha], { GIT_INDEX_FILE: indexFile });
      git(['checkout-index', '-a', '-f', `--prefix=${prefix}`], { GIT_INDEX_FILE: indexFile });
    } finally {
      fs.rmSync(indexFile, { force: true });
    }

    // The deployment has no node_modules and no build step. Install the exported commit's locked
    // dependencies here, run its own bundle script, record the hashes, then remove node_modules
    // before the tree is swapped into place.
    const bundleScript = path.join(temp, 'scripts', 'bundle.ts');
    if (!fs.existsSync(bundleScript)) {
      throw new Error(
        'the staged commit has no scripts/bundle.ts; it predates the self-contained build. Restage a commit that has it.',
      );
    }
    const installDependencies = input.installDependencies ?? true;
    if (installDependencies) {
      for (const required of ['package.json', 'yarn.lock']) {
        if (!fs.existsSync(path.join(temp, required))) {
          throw new Error(`the staged commit has no ${required}; it cannot be installed and bundled`);
        }
      }
      const install = spawnSync('corepack', ['yarn', 'install', '--immutable'], {
        cwd: temp,
        encoding: 'utf8',
      });
      if (install.status !== 0) {
        throw new Error(
          `installing the staged commit failed: ${
            (install.stderr ?? '').trim() ||
            (install.error as Error | undefined)?.message ||
            `exit ${String(install.status)}`
          }`,
        );
      }
    }
    try {
      const bundle = spawnSync(process.execPath, [bundleScript], { cwd: temp, encoding: 'utf8' });
      if (bundle.status !== 0) {
        throw new Error(
          `bundling the staged commit failed: ${(bundle.stderr ?? '').trim() || `exit ${String(bundle.status)}`}`,
        );
      }
    } finally {
      fs.rmSync(path.join(temp, 'node_modules'), { recursive: true, force: true });
    }
    const digest = (file: string): string =>
      createHash('sha256').update(fs.readFileSync(path.join(temp, file))).digest('hex');
    const bundles = { gcb: digest('dist/gcb.js'), daemon: digest('dist/gcb-daemon.js') };

    writeSecretFile(
      path.join(temp, recordName),
      `${JSON.stringify(
        { ref: input.ref, sha, subject, stagedAt: new Date().toISOString(), bundles },
        null,
        2,
      )}\n`,
      0o644,
    );

    // Swap. Renaming the old tree aside first keeps the window small and lets a failed second rename
    // put it back; the old tree is only removed after the new one is in place.
    if (fs.existsSync(to)) {
      fs.renameSync(to, old);
      oldExists = true;
    }
    try {
      fs.renameSync(temp, to);
      tempExists = false;
    } catch (error) {
      if (oldExists) {
        try {
          fs.renameSync(old, to);
          oldExists = false;
        } catch {
          // The new tree could not be installed and the old one could not be restored; report the
          // original failure and leave the old path visible for the operator.
        }
      }
      throw error;
    }
    if (oldExists) {
      try {
        fs.rmSync(old, { recursive: true, force: true });
        oldExists = false;
      } catch {
        // A leftover old tree is noise, not a failed stage: the new tree is already in place.
      }
    }

    return { to, sha, subject, files, dirtyWorkingTree, bundles };
  } finally {
    if (tempExists) fs.rmSync(temp, { recursive: true, force: true });
  }
}

/** Usage text for `stage`. */
export const STAGE_USAGE = `Usage: git-credential-broker stage [options]

Export the broker from a reviewed commit into the directory it will run from.

  --repo <path>    Repository to export from (default: the one containing this directory)
  --to <path>      Where the broker will run from   [required: outside every container mount]
  --ref <commit>   Commit to export (default: HEAD; never the working tree)
  --force          Replace a target this command did not stage itself
  -h, --help       Show this help

The broker reads the App private key, so it must not execute code the agent can rewrite. Exporting
from a commit rather than copying the working tree is what makes the staged code reviewable; the
sha is printed so you can check it against your own clone or the remote, because a repository the
agent can write to is a repository whose commits the agent can rewrite.

The staged commit is installed with \`corepack yarn install --immutable\`, bundled with its own
script, and has \`node_modules\` removed afterwards. Stage therefore needs corepack and registry
access; the deployment needs neither. Then run the self-contained bundle from there:

  node <to>/dist/gcb-daemon.js --config <deployment directory>/broker.config.toml
`;

/**
 * Run the `stage` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code.
 */
export function runStage(argv: readonly string[]): number {
  const args = parseArgs(argv, { booleans: ['force', 'help'] });
  if (args.has('help') || args.has('h')) {
    say(STAGE_USAGE);
    return 0;
  }

  const to = args.value('to');
  if (!to) fail('--to is required (a directory outside every container mount, e.g. /volume1/docker/git-cred-broker/app)');

  const repo = args.value('repo') ?? process.cwd();
  try {
    const result = performStage({ repo, to, ref: args.value('ref') ?? 'HEAD', force: args.has('force') });
    say(`staged    : ${result.to}`);
    say(`from      : ${result.sha.slice(0, 12)}  ${result.subject}`);
    say(`contents  : ${result.files} files, from the commit — nothing from the working tree`);
    if (result.dirtyWorkingTree) {
      warn('the working tree has uncommitted changes; they are NOT staged, which is the point');
    }
    say('');
    say('Verify that sha against your own clone or the remote before trusting it: a repository the');
    say('agent can write to is one whose commits the agent can rewrite.');
    return 0;
  } catch (error) {
    fail((error as Error).message);
  }
}
