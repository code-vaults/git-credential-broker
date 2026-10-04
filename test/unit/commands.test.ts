/**
 * Tests for the management commands.
 *
 * These are the operations that used to be shell scripts, so the cases that matter are the
 * guard rails: writing through a symlink, putting a key inside a container mount, and deploying
 * a configuration the daemon would reject.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { renderCompose } from '../../src/commands/compose.ts';
import { runDiagnose } from '../../src/commands/diagnose.ts';
import { SIDECAR, resolveConfigPath, deploymentDir } from '../../src/config.ts';
import { appBlock, buildBrokerConfig, mergeAllowList, parsePermissions, performInit } from '../../src/commands/init.ts';
import { parseArgs, listFlag, insideMountedPath, mountedPaths } from '../../src/commands/support.ts';
import { defaultHelperPath, performSetup } from '../../src/commands/setup.ts';
import type { BrokerConfig, GithubAppHostConfig } from '../../src/types.ts';
import { runProbe } from '../../src/commands/probe.ts';

/** Scratch space for the whole file. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-commands-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/**
 * A throwaway directory under the scratch root.
 *
 * @param name - a label for the directory.
 * @returns the absolute path, created.
 */
function dir(name: string): string {
  const target = path.join(scratch, name);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

/**
 * Write a throwaway RSA private key.
 *
 * @param target - where to write it.
 * @returns the path.
 */
function writeKey(target: string): string {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(target, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  return target;
}

/**
 * Read a git config file's entries.
 *
 * @param file - the config file.
 * @returns `key=value` lines.
 */
function gitEntries(file: string): string[] {
  const output = execFileSync('git', ['config', '--file', file, '--list'], { encoding: 'utf8' });
  return output.split('\n').filter((line) => line.length > 0);
}

/**
 * The github-app host block of a config, narrowed past the provider union.
 *
 * @param config - a validated configuration.
 * @returns the host block.
 */
function appHost(config: BrokerConfig): GithubAppHostConfig {
  const block = config.hosts['github.com'];
  if (block?.provider !== 'github-app') throw new Error('expected a github-app host block');
  return block;
}

describe('parseArgs', () => {
  it('reads values, repeated flags and booleans', () => {
    const args = parseArgs(['--allow', 'a/b', '--allow', 'c/d', '--force', '--dir=/tmp/x', 'positional'], {
      booleans: ['force'],
    });
    assert.deepEqual(args.values('allow'), ['a/b', 'c/d']);
    assert.equal(args.value('dir'), '/tmp/x');
    assert.equal(args.has('force'), true);
    assert.deepEqual(args.positionals, ['positional']);
  });

  it('splits comma-separated list flags', () => {
    const args = parseArgs(['--allow', 'a/b,c/d', '--allow', 'e/f']);
    assert.deepEqual(listFlag(args, 'allow'), ['a/b', 'c/d', 'e/f']);
  });

  it('treats a flag followed by another flag as a boolean, not a value', () => {
    const args = parseArgs(['--force', '--dir', '/tmp']);
    assert.equal(args.has('force'), true);
    assert.equal(args.value('dir'), '/tmp');
  });
});

describe('mounted path detection', () => {
  /** A home and a shared-directory list stated here, so no case reads the machine's own mount table. */
  const home = '/home/u';
  const mounts = ['/home/u/shared', '/home/u/cache', '/home/u/notes'];

  it('is inside a shared directory, and not a sibling that merely starts the same', () => {
    assert.equal(insideMountedPath('/home/u/shared/x', home, mounts), '/home/u/shared');
    assert.equal(insideMountedPath('/home/u/cache/git-broker', home, mounts), '/home/u/cache');
    assert.equal(insideMountedPath('/srv/other', home, mounts), null);
    assert.equal(insideMountedPath('/home/u/shared-evil', home, mounts), null, 'must not prefix-match a sibling');
  });

  it('reads them from the container mount table', () => {
    const table = [
      `675 573 0:36 /x ${home}/shared rw - btrfs /dev/x rw`,
      `676 573 0:36 /y ${home}/with\\040space rw - btrfs /dev/x rw`,
      '677 573 0:36 /z /somewhere/else rw - btrfs /dev/x rw',
    ].join('\n');
    assert.deepEqual(mountedPaths(home, { mountinfo: table, container: true }), [
      `${home}/shared`,
      `${home}/with space`,
    ]);
  });

  it('asks the container runtime on the host, and keeps the bind mounts that touch the home', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-inspect-'));
    const inside = path.join(base, 'shared');
    const deeper = path.join(base, 'sub', 'deep');
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(deeper, { recursive: true });
    const inspect = [
      JSON.stringify([
        { Type: 'bind', Source: inside, Destination: '/home/u/shared' },
        { Type: 'bind', Source: deeper, Destination: '/home/u/cache' },
        { Type: 'volume', Source: path.join(base, 'volume'), Destination: '/vol' },
        { Type: 'bind', Source: '/srv/elsewhere', Destination: '/srv/elsewhere' },
      ]),
    ].join('\n');
    try {
      const got = mountedPaths(base, { container: false, inspect })
        .map((entry) => fs.realpathSync(entry))
        .sort();
      assert.deepEqual(
        got,
        [inside, deeper].map((entry) => fs.realpathSync(entry)).sort(),
        'a volume and an unrelated path are not shared directories',
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('asks for every container, not only the running ones', () => {
    // A stopped container still has its bind mounts configured, and can be started again at any time.
    // `init` runs on a fresh host and from boot scripts, which is exactly when a running-only list is
    // blind. Regression: an empty runtime answer used to be trusted as "nothing is shared".
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-runtime-'));
    const inside = path.join(base, 'shared');
    fs.mkdirSync(inside, { recursive: true });
    const calls: string[][] = [];
    const exec = (cli: string, args: readonly string[]): string => {
      calls.push([cli, ...args]);
      if (args[0] === 'ps') return 'b3f1c2d4e5f6\n';
      return JSON.stringify([{ Type: 'bind', Source: inside, Destination: '/home/u/shared' }]);
    };
    try {
      assert.deepEqual(
        mountedPaths(base, { container: false, exec }).map((entry) => fs.realpathSync(entry)),
        [fs.realpathSync(inside)],
        'a stopped container is still a container that can rewrite the staged code',
      );
      assert.equal(calls[0]?.includes('--all'), true, 'ps must include the containers that are not running');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('counts a mount that contains the home, not only ones under it', () => {
    // A container that binds the home's parent can rewrite everything in the home.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-ancestor-'));
    const homeDir = path.join(base, 'u');
    fs.mkdirSync(homeDir, { recursive: true });
    const exec = (_cli: string, args: readonly string[]): string =>
      args[0] === 'ps' ? 'b3f1c2d4e5f6\n' : JSON.stringify([{ Type: 'bind', Source: base, Destination: '/mnt' }]);
    try {
      assert.deepEqual(
        mountedPaths(homeDir, { container: false, exec }).map((entry) => fs.realpathSync(entry)),
        [fs.realpathSync(base)],
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('refuses when the runtime knows of no container at all', () => {
    // Installed but empty is not "nothing is shared": it is the state in which the check is blind.
    const exec = (_cli: string, args: readonly string[]): string => (args[0] === 'ps' ? '' : '[]');
    assert.throws(
      () => mountedPaths(home, { container: false, exec }),
      /could be asked, or none knows of a container/,
    );
  });

  it('treats a missing runtime as absent, but an installed failing one as a blind spot', () => {
    const failure = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
    const one = (cli: string, args: readonly string[]): string => {
      if (cli !== 'podman') throw failure('ENOENT');
      return args[0] === 'ps' ? 'id-1\n' : JSON.stringify([{ Type: 'bind', Source: '/srv', Destination: '/srv' }]);
    };
    assert.deepEqual(
      mountedPaths('/srv/u', { container: false, exec: one }),
      ['/srv'],
      'a host with one runtime must not be refused because the others are not installed',
    );
    const unreachable = (cli: string, args: readonly string[]): string => {
      if (cli === 'docker') throw failure('ECONNREFUSED');
      return one(cli, args);
    };
    assert.throws(
      () => mountedPaths('/srv/u', { container: false, exec: unreachable }),
      /could be asked, or none knows of a container/,
      'a runtime that is installed but unreachable hides its containers, so another list cannot cover for it',
    );
  });

  it('refuses rather than guess when nothing can answer', () => {
    assert.throws(
      () => mountedPaths(home, { container: false, inspect: null }),
      /refusing rather than guessing/,
    );
  });

  it('resolves the aliases of one directory instead of trusting the spelling', () => {
    // One shared directory can have two spellings — a symlinked home, a bind mount reached two ways —
    // so a lexical prefix check calls a path inside it outside, which is how `stage` wrote the broker's
    // code into a directory the agent can rewrite.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-mount-alias-'));
    const real = path.join(root, 'real');
    fs.mkdirSync(path.join(real, 'data'), { recursive: true });
    const alias = path.join(root, 'alias');
    // 'junction' so the case also runs on Windows, where a plain symlink needs a privilege; the type is
    // ignored on the platforms that have no junctions.
    fs.symlinkSync(real, alias, 'junction');
    try {
      const mounted = path.join(alias, 'data');
      const shared = [mounted];
      assert.equal(
        insideMountedPath(path.join(real, 'data', 'x'), alias, shared),
        mounted,
        'real target, aliased mount',
      );
      assert.equal(insideMountedPath(path.join(real, 'data'), alias, shared), mounted, 'and the mount itself');
      assert.equal(insideMountedPath(path.join(real, 'elsewhere'), alias, shared), null, 'a sibling is still outside');
      assert.equal(
        insideMountedPath(path.join(alias, 'data', 'y'), real, [path.join(real, 'data')]),
        path.join(real, 'data'),
        'and the reverse spelling',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('canonicalizes a mount that does not exist yet, which is the path stage is asked to create', () => {
    // `stage --to` is normally a directory that is not there yet, so the mount's own path may not exist
    // either. The nearest existing ancestor has to be resolved on both sides or the spellings differ.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-mount-missing-'));
    const real = path.join(root, 'real');
    fs.mkdirSync(real, { recursive: true });
    const alias = path.join(root, 'alias');
    fs.symlinkSync(real, alias, 'junction');
    try {
      const mounted = path.join(alias, 'data');
      const shared = [mounted];
      assert.equal(insideMountedPath(path.join(real, 'data', 'new', 'deep'), alias, shared), mounted);
      assert.equal(insideMountedPath(path.join(real, 'data'), alias, shared), mounted);
      assert.equal(
        insideMountedPath(path.join(real, 'data-evil'), alias, shared),
        null,
        'a sibling is not inside, with the mount missing too',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('setup', () => {
  /**
   * Build setup input pointing at scratch paths.
   *
   * @param overrides - fields to replace.
   * @returns the input.
   */
  function setupInput(overrides: Partial<Parameters<typeof performSetup>[0]> = {}) {
    const base = dir(`setup-${Math.random().toString(36).slice(2)}`);
    return {
      helper: '/opt/git-credential-broker/dist/cli/helper.js',
      socket: '/run/git-cred-broker/broker.sock',
      gitconfig: path.join(base, '.gitconfig'),
      envFile: path.join(base, '.git-broker.env'),
      socketFile: path.join(base, '.config', 'git-credential-broker', 'socket'),
      caBundlePath: path.join(base, '.config', 'git-credential-broker', 'ca-bundle.pem'),
      rewriteSshHost: 'github.com',
      dryRun: false,
      // Stated, so the shared-directory resolution does not read this machine's mount table.
      mounts: [],
      ...overrides,
    };
  }

  it('records the running script, and refuses to configure native Windows at all', async () => {
    assert.equal(defaultHelperPath(), fs.realpathSync(process.argv[1] as string));

    // On native Windows the broker's socket cannot be reached, so writing a helper there would look
    // like success and never work. Nothing should be written on the way to the refusal.
    const input = setupInput();
    await assert.rejects(() => performSetup({ ...input, platform: 'win32' }), /native Windows is not supported/);
    assert.equal(fs.existsSync(input.gitconfig), false);
  });

  it('writes the three settings git needs, and both socket-path records', async () => {
    const input = setupInput();
    const result = await performSetup(input);

    const entries = gitEntries(input.gitconfig);
    assert.equal(entries.includes(`credential.helper=${input.helper}`), true);
    assert.equal(entries.includes('credential.usehttppath=true'), true);
    assert.equal(entries.includes('url.https://github.com/.insteadof=git@github.com:'), true);

    assert.equal(fs.readFileSync(input.socketFile, 'utf8').trim(), input.socket);
    assert.match(fs.readFileSync(input.envFile, 'utf8'), /GIT_BROKER_REQUIRE=1/);
    assert.equal(fs.statSync(input.gitconfig).mode & 0o777, 0o600);
    assert.equal(result.warnings.some((warning) => warning.includes('no broker socket')), true);
  });

  it('writes nothing on a dry run', async () => {
    const input = setupInput({ dryRun: true });
    const result = await performSetup(input);
    assert.equal(fs.existsSync(input.gitconfig), false);
    assert.equal(result.entries.length > 0, true, 'but still reports what it would do');
  });

  it('refuses to write through a symlink', async () => {
    const base = dir(`setup-link-${Math.random().toString(36).slice(2)}`);
    const real = path.join(base, 'real-gitconfig');
    fs.writeFileSync(real, '[user]\n\tname = host\n');
    const link = path.join(base, '.gitconfig');
    fs.symlinkSync(real, link);

    await assert.rejects(() => performSetup(setupInput({ gitconfig: link })), /symlink/);
    assert.equal(fs.readFileSync(real, 'utf8'), '[user]\n\tname = host\n', 'the target must be untouched');
  });

  it('can leave ssh remotes alone', async () => {
    const input = setupInput({ rewriteSshHost: null });
    await performSetup(input);
    assert.equal(gitEntries(input.gitconfig).some((entry) => entry.includes('insteadof')), false);
  });

  it('refuses a config inside a container mount, whatever the mount is spelled', async () => {
    // One shared directory can have two spellings (a symlinked home, a bind mount). The check this
    // replaced compared spellings, so the container's was accepted and the host's own git config would
    // be written where the container can rewrite it.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-mount-alias-'));
    const real = path.join(base, 'real');
    fs.mkdirSync(path.join(real, 'shared'), { recursive: true });
    const alias = path.join(base, 'alias');
    fs.symlinkSync(real, alias, 'junction');
    try {
      const gitconfig = path.join(real, 'shared', 'gitconfig');
      await assert.rejects(
        () => performSetup(setupInput({ gitconfig, home: alias, mounts: [path.join(alias, 'shared')], dryRun: true })),
        /mounted into the container/,
      );
      assert.equal(fs.existsSync(gitconfig), false, 'and nothing was written');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('init', () => {
  /** A fake home, so the mount checks are hermetic rather than dependent on the machine. */
  const fakeHome = dir('init-home');
  const baseInput = {
    allow: ['acme/widget'],
    hostSocketPath: '/run/git-cred-broker/broker.sock',
    clientId: 'Iv1.example',
    appId: 123456,
    permissions: { contents: 'write' },
    force: false,
    // This suite runs inside the very container init refuses to run in, so the detected
    // environment is injected. The guard itself is exercised by the tests below.
    env: { isInsideContainer: () => false, home: fakeHome, mounts: [] },
  };

  it('installs the key 0600 and writes a config the daemon accepts', () => {
    const root = dir(`init-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));

    const result = performInit({ ...baseInput, cert, dir: path.join(root, 'deploy') });

    assert.equal(fs.statSync(result.keyPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.configPath).mode & 0o777, 0o600);
    assert.equal(result.config.hosts['github.com']?.allow[0], 'acme/widget');
    assert.equal(result.config.socketPath, baseInput.hostSocketPath);
    assert.equal(result.mode, 'host');
  });

  it('records host paths in host mode and sidecar paths in sidecar mode', () => {
    const root = dir(`init-modes-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));
    const dir0 = path.join(root, 'deploy');

    const hostMode = performInit({ ...baseInput, cert, dir: dir0 });
    const hostKey = appHost(hostMode.config).privateKeyPath;
    assert.equal(hostKey, path.join(dir0, 'app.pem'), 'a host process reads the host path');
    assert.equal(hostMode.config.auditPath, path.join(dir0, 'log', 'audit.jsonl'));

    // Omitted entirely: a plain `init --mode sidecar` must not be rejected for a flag it does
    // not need, which is exactly the bug this covers.
    const sidecarMode = performInit({
      ...baseInput,
      hostSocketPath: undefined,
      cert,
      dir: dir0,
      mode: 'sidecar',
      force: true,
    });
    assert.equal(appHost(sidecarMode.config).privateKeyPath, SIDECAR.keyPath);
    assert.equal(sidecarMode.config.socketPath, SIDECAR.socketPath);
    assert.equal(sidecarMode.config.auditPath, SIDECAR.auditPath);
    // The key itself is still a host file in both modes; only what the config records differs.
    assert.equal(sidecarMode.keyPath, path.join(dir0, 'app.pem'));
  });

  it('rejects an override that the sidecar deployment fixes, instead of ignoring it', () => {
    const root = dir(`init-fixed-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));
    assert.throws(
      () =>
        performInit({
          ...baseInput,
          cert,
          dir: path.join(root, 'deploy'),
          mode: 'sidecar',
          hostSocketPath: '/somewhere/else.sock',
        }),
      /must be \/run\/git-broker\/broker\.sock with --mode sidecar/,
    );
  });

  it('refuses to run inside the container', () => {
    const root = dir(`init-container-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));
    assert.throws(
      () =>
        performInit({
          ...baseInput,
          cert,
          dir: path.join(root, 'deploy'),
          env: { ...baseInput.env, isInsideContainer: () => true },
        }),
      /must run outside it/,
    );
  });

  it('refuses a key inside a container mount', () => {
    const root = dir(`init-mount-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));
    const mounted = path.join(fakeHome, 'shared', 'somewhere');
    assert.throws(
      () =>
        performInit({
          ...baseInput,
          cert,
          dir: mounted,
          env: { ...baseInput.env, mounts: [path.join(fakeHome, 'shared')] },
        }),
      /mounted into the container/,
      'the private key must never live where the container can read it',
    );
  });

  it('refuses a malformed allowlist entry rather than writing a config that matches nothing', () => {
    const root = dir(`init-allow-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));
    for (const bad of ['acme', 'acme/wid*', 'acme/other/extra']) {
      assert.throws(
        () => performInit({ ...baseInput, cert, dir: path.join(root, 'deploy'), allow: [bad] }),
        /not a valid/,
        `expected ${bad} to be rejected`,
      );
    }
  });

  it('refuses a file that is not a private key, and an empty allowlist', () => {
    const root = dir(`init-cert-${Math.random().toString(36).slice(2)}`);
    const notAKey = path.join(root, 'not-a-key.pem');
    fs.writeFileSync(notAKey, 'hello\n');
    assert.throws(() => performInit({ ...baseInput, cert: notAKey, dir: path.join(root, 'a') }), /PEM private key/);

    const cert = writeKey(path.join(root, 'real.pem'));
    assert.throws(
      () => performInit({ ...baseInput, cert, dir: path.join(root, 'b'), allow: [] }),
      /default-deny/,
    );
  });

  it('adds a repository without dropping the others, and without re-supplying anything', () => {
    // The bug this replaces: adding one repository required every flag, and --force then
    // silently replaced the allowlist, so adding b/two could quietly drop a/one.
    const root = dir(`init-merge-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));
    const target = path.join(root, 'deploy');

    performInit({ ...baseInput, cert, dir: target, allow: ['a/one'] });
    const updated = performInit({
      ...baseInput,
      cert: undefined,
      clientId: undefined,
      appId: undefined,
      permissions: undefined,
      dir: target,
      allow: ['b/two'],
    });

    assert.deepEqual(appBlock(updated.config).allow, ['a/one', 'b/two']);
    assert.deepEqual(appBlock(updated.previous as never).allow, ['a/one']);
    assert.equal(updated.previous !== undefined, true);
  });

  it('preserves edits made to the file by hand', () => {
    const root = dir(`init-hand-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));
    const target = path.join(root, 'deploy');
    performInit({ ...baseInput, cert, dir: target, allow: ['a/one'] });

    const file = path.join(target, 'broker.config.json');
    const edited = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      hosts: Record<string, { permissions?: unknown }>;
    };
    const editedBlock = edited.hosts['github.com'];
    assert.ok(editedBlock, 'the config must have a github.com block');
    editedBlock.permissions = { contents: 'write', pull_requests: 'write' };
    fs.writeFileSync(file, JSON.stringify(edited, null, 2));

    const updated = performInit({
      ...baseInput,
      cert: undefined,
      permissions: undefined,
      dir: target,
      allow: ['c/three'],
    });
    assert.deepEqual(appBlock(updated.config).permissions, { contents: 'write', pull_requests: 'write' });
    assert.deepEqual(appBlock(updated.config).allow, ['a/one', 'c/three']);
  });

  it('removes and replaces entries only when asked', () => {
    const root = dir(`init-remove-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));
    const target = path.join(root, 'deploy');
    performInit({ ...baseInput, cert, dir: target, allow: ['a/one', 'b/two', 'c/three'] });

    const afterRemove = performInit({
      ...baseInput,
      cert: undefined,
      dir: target,
      allow: [],
      removeAllow: ['b/two'],
    });
    assert.deepEqual(appBlock(afterRemove.config).allow, ['a/one', 'c/three']);

    const afterReplace = performInit({
      ...baseInput,
      cert: undefined,
      dir: target,
      allow: ['z/last'],
      replaceAllow: true,
    });
    assert.deepEqual(appBlock(afterReplace.config).allow, ['z/last']);
  });

  it('never lets an update empty the allowlist', () => {
    const root = dir(`init-empty-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));
    const target = path.join(root, 'deploy');
    performInit({ ...baseInput, cert, dir: target, allow: ['a/one'] });
    assert.throws(
      () => performInit({ ...baseInput, cert: undefined, dir: target, allow: [], removeAllow: ['a/one'] }),
      /default-deny/,
    );
  });

  it('switches deployment only when asked by name, and never carries the other layout over', () => {
    const root = dir(`init-mode-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));
    const target = path.join(root, 'deploy');
    performInit({ ...baseInput, cert, dir: target, allow: ['a/one'] });

    // host -> sidecar needs nothing extra (and the host socket path must not be forced on it),
    // and keeps the allowlist.
    const toSidecar = performInit({
      ...baseInput,
      cert: undefined,
      dir: target,
      allow: [],
      mode: 'sidecar',
      hostSocketPath: undefined,
    });
    assert.equal(toSidecar.mode, 'sidecar');
    assert.equal(appBlock(toSidecar.config).privateKeyPath, SIDECAR.keyPath);
    assert.equal(toSidecar.config.socketPath, SIDECAR.socketPath);
    assert.equal(
      toSidecar.config.auditPath,
      SIDECAR.auditPath,
      'the host audit path must not follow the config into the sidecar',
    );
    assert.deepEqual(appBlock(toSidecar.config).allow, ['a/one']);

    // sidecar -> host without a socket path is refused: the one on file belongs to the sidecar,
    // and a host process cannot bind it.
    assert.throws(
      () =>
        performInit({
          ...baseInput,
          cert: undefined,
          dir: target,
          allow: [],
          mode: 'host',
          hostSocketPath: undefined,
        }),
      /records the sidecar's socket path .*pass --socket-path/,
    );

    // and with one, the host layout is rebuilt rather than inherited.
    const toHost = performInit({
      ...baseInput,
      cert: undefined,
      dir: target,
      allow: [],
      mode: 'host',
      hostSocketPath: '/volume1/some/dir/broker.sock',
    });
    assert.equal(toHost.mode, 'host');
    assert.equal(appBlock(toHost.config).privateKeyPath, path.join(target, 'app.pem'));
    assert.equal(toHost.config.socketPath, '/volume1/some/dir/broker.sock');
    assert.equal(toHost.config.auditPath, path.join(target, 'log', 'audit.jsonl'), 'not the sidecar path');
    assert.deepEqual(appBlock(toHost.config).allow, ['a/one']);
  });

  it('says so when the key the config points at has gone', () => {
    const root = dir(`init-nokey-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));
    const target = path.join(root, 'deploy');
    performInit({ ...baseInput, cert, dir: target, allow: ['a/one'] });
    fs.rmSync(path.join(target, 'app.pem'));
    assert.throws(
      () => performInit({ ...baseInput, cert: undefined, dir: target, allow: ['b/two'] }),
      /pass --cert to install the key/,
    );
  });

  it('parses permission lists and rejects malformed ones', () => {
    assert.equal(parsePermissions(undefined), undefined, 'absent in an update means "leave it alone"');
    assert.deepEqual(parsePermissions('contents=write,pull_requests=write'), {
      contents: 'write',
      pull_requests: 'write',
    });
    assert.throws(() => parsePermissions('contents'), /name=level/);
  });

  it('builds a config through the daemon validator, so bad input fails here', () => {
    assert.throws(
      () =>
        buildBrokerConfig({
          ...baseInput,
          cert: '/tmp/whatever.pem',
          dir: '/tmp/deploy',
          clientId: '',
          hostSocketPath: '',
        }),
      /socketPath is required/,
    );
  });
});

describe('mergeAllowList', () => {
  it('adds, deduplicates case-insensitively and preserves order', () => {
    assert.deepEqual(mergeAllowList(['a/one'], { dir: '/x', allow: ['b/two'], force: false }), ['a/one', 'b/two']);
    assert.deepEqual(mergeAllowList(['a/one'], { dir: '/x', allow: ['A/One'], force: false }), ['a/one']);
  });

  it('refuses to produce an empty allowlist, which would authorize nothing', () => {
    assert.throws(() => mergeAllowList([], { dir: '/x', allow: [], force: false }), /default-deny/);
    assert.throws(
      () => mergeAllowList(['a/one'], { dir: '/x', replaceAllow: true, force: false }),
      /default-deny/,
    );
  });

  it('removes, and replaces only when told to', () => {
    assert.deepEqual(
      mergeAllowList(['a/one', 'b/two'], { dir: '/x', removeAllow: ['A/ONE'], force: false }),
      ['b/two'],
    );
    assert.deepEqual(
      mergeAllowList(['a/one', 'b/two'], { dir: '/x', allow: ['c/three'], replaceAllow: true, force: false }),
      ['c/three'],
    );
  });

  it('rejects a malformed entry instead of writing it', () => {
    for (const bad of ['acme', 'acme/wid*', 'acme/other/extra']) {
      assert.throws(() => mergeAllowList([], { dir: '/x', allow: [bad], force: false }), /not a valid/);
    }
  });
});

describe('diagnose', () => {
  it('explains a sidecar configuration instead of failing to read its key', async () => {
    // The case that produced this test: `diagnose` run on the host against a config written for the
    // sidecar, which died with a bare ENOENT about a path it could never have had.
    const root = dir(`diagnose-${Math.random().toString(36).slice(2)}`);
    const configPath = path.join(root, 'broker.config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        socketPath: SIDECAR.socketPath,
        auditPath: SIDECAR.auditPath,
        hosts: {
          'github.com': {
            provider: 'github-app',
            allow: ['a/one'],
            clientId: 'Iv1.example',
            appId: 1,
            privateKeyPath: SIDECAR.keyPath,
            permissions: { contents: 'write' },
          },
        },
      }),
    );

    // runDiagnose refuses to start when a proxy is configured without the switch, and it reads the real
    // environment, so the variables are taken away for the call: the assertion is about the sidecar message,
    // not about the machine this runs on.
    const proxyVars = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'NODE_USE_ENV_PROXY'];
    const savedProxy = proxyVars.map((name) => [name, process.env[name]] as const);
    try {
      for (const name of proxyVars) delete process.env[name];
      await assert.rejects(
        () => runDiagnose(['--config', configPath]),
        /exists only inside the sidecar container/,
      );
    } finally {
      for (const [name, value] of savedProxy) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('socket discovery', () => {
  it('honours the socket file, the way the git helper does', async () => {
    // Regression: probe and logs accepted only --socket and $GIT_BROKER_SOCKET, so in a shell
    // without the environment they refused even though git itself would have found the broker.
    const root = dir(`socket-file-${Math.random().toString(36).slice(2)}`);
    const socketFile = path.join(root, 'socket');
    fs.writeFileSync(socketFile, path.join(root, 'absent.sock'));

    const savedSocket = process.env['GIT_BROKER_SOCKET'];
    const savedFile = process.env['GIT_BROKER_SOCKET_FILE'];
    delete process.env['GIT_BROKER_SOCKET'];
    process.env['GIT_BROKER_SOCKET_FILE'] = socketFile;
    try {
      const code = await runProbe(['--host', 'github.com', '--repo', 'a/one']);
      assert.equal(code, 3, 'it must use the path from the file and report the broker unreachable');
    } finally {
      if (savedSocket === undefined) delete process.env['GIT_BROKER_SOCKET'];
      else process.env['GIT_BROKER_SOCKET'] = savedSocket;
      if (savedFile === undefined) delete process.env['GIT_BROKER_SOCKET_FILE'];
      else process.env['GIT_BROKER_SOCKET_FILE'] = savedFile;
    }
  });
});

describe('config discovery', () => {
  it('prefers --config, then GIT_BROKER_CONFIG, then ./broker.config.json', () => {
    assert.equal(resolveConfigPath('/a/b.json', {}), '/a/b.json');
    assert.equal(resolveConfigPath(undefined, { GIT_BROKER_CONFIG: '/c/d.json' }), '/c/d.json');
    assert.equal(resolveConfigPath(undefined, {}), path.resolve('broker.config.json'));
  });

  it('takes the deployment directory from the config path, so --dir is not needed', () => {
    const found = resolveConfigPath(undefined, { GIT_BROKER_CONFIG: '/volume1/docker/git-cred-broker/broker.config.json' });
    assert.equal(deploymentDir(found), '/volume1/docker/git-cred-broker');
  });

  it('writes to an explicit --config path, creating its directory', () => {
    const root = dir(`init-configpath-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));
    const custom = path.join(root, 'elsewhere', 'broker.json');

    const result = performInit({
      cert,
      dir: path.join(root, 'deploy'),
      configPath: custom,
      allow: ['a/one'],
      clientId: 'Iv1.example',
      appId: 123456,
      permissions: { contents: 'write' },
      force: false,
      env: { isInsideContainer: () => false, home: dir('discovery-home'), mounts: [] },
    });

    assert.equal(result.configPath, custom);
    assert.equal(fs.existsSync(custom), true);
    assert.equal(fs.existsSync(path.join(root, 'deploy', 'broker.config.json')), false, 'and not in --dir as well');
  });
});

describe('compose', () => {
  const rendered = renderCompose({
    dir: '/volume1/docker/git-cred-broker',
    socketDir: '/srv/shared/git-broker',
    user: '1026:100',
    image: 'node:24-slim',
    packageSpec: 'git-credential-broker@0.1.0',
    name: 'git-cred-broker',
  });

  it('mounts the key read-only and publishes no ports', () => {
    assert.match(rendered, /app\.pem:\/etc\/git-cred-broker\/app\.pem:ro/);
    assert.match(rendered, /broker\.config\.json:\/etc\/git-cred-broker\/broker\.config\.json:ro/);
    assert.equal(/^\s+ports:/m.test(rendered), false, 'the socket is the only interface');
  });

  it('drops privileges and keeps the root filesystem read-only', () => {
    assert.match(rendered, /cap_drop:\n\s+- ALL/);
    assert.match(rendered, /no-new-privileges:true/);
    assert.match(rendered, /read_only: true/);
    assert.match(rendered, /user: "1026:100"/);
  });

  it('runs the daemon from the published package, not from a copied checkout', () => {
    assert.match(rendered, /npx --yes --package 'git-credential-broker@0\.1\.0' git-credential-brokerd/);
    assert.match(rendered, new RegExp(`--config ${SIDECAR.configPath}`));
  });

  it('can run staged code from a mount instead, fetching and building nothing at boot', () => {
    const fromCode = renderCompose({
      dir: '/volume1/docker/git-cred-broker',
      socketDir: '/srv/shared/git-broker',
      user: '1026:100',
      image: 'node:24-slim',
      packageSpec: 'git-credential-broker@0.1.0',
      name: 'git-cred-broker',
      code: '/volume1/docker/git-cred-broker/app',
    });

    assert.match(fromCode, /- \/volume1\/docker\/git-cred-broker\/app:\/opt\/git-credential-broker:ro/);
    assert.match(fromCode, /- node\n\s+- \/opt\/git-credential-broker\/src\/cli\/daemon\.ts/);
    assert.equal(/npx/.test(fromCode), false, 'no registry access at start');
    assert.equal(/npm_config_cache/.test(fromCode), false, 'and so no cache to write');
    assert.match(fromCode, /STAGED\.json/, 'it points at the record of which commit this is');
    // Everything that matters for isolation is unchanged.
    assert.match(fromCode, /cap_drop:\n\s+- ALL/);
    assert.match(fromCode, /read_only: true/);
    assert.equal(/^\s+ports:/m.test(fromCode), false);
  });

  it('states the config paths it requires, so --mode sidecar is discoverable', () => {
    assert.match(rendered, /git-credential-broker init --mode sidecar/);
    assert.match(rendered, new RegExp(`privateKeyPath ${SIDECAR.keyPath.replace(/[/.]/g, '\\$&')}`));
  });

  it('mounts exactly the paths a --mode sidecar config records', () => {
    // The regression this guards: `init` once recorded host paths while `compose` mounted the
    // files at container paths, so the sidecar could not read its own key.
    const deployDir = '/volume1/docker/git-cred-broker';
    const config = buildBrokerConfig({
      cert: '/tmp/unused.pem',
      dir: deployDir,
      allow: ['acme/widget'],
      hostSocketPath: '/ignored-in-sidecar-mode.sock',
      mode: 'sidecar',
      clientId: 'Iv1.x',
      appId: 1,
      permissions: { contents: 'write' },
      force: true,
    });

    assert.equal(config.socketPath, SIDECAR.socketPath);
    assert.equal(appHost(config).privateKeyPath, SIDECAR.keyPath);
    assert.equal(config.auditPath, SIDECAR.auditPath);

    assert.equal(rendered.includes(`${deployDir}/broker.config.json:${SIDECAR.configPath}:ro`), true);
    assert.equal(rendered.includes(`${deployDir}/app.pem:${SIDECAR.keyPath}:ro`), true);
    assert.equal(rendered.includes(`${deployDir}/log:${SIDECAR.auditDir}`), true);
    assert.equal(
      rendered.includes('/srv/shared/git-broker:' + SIDECAR.socketDir),
      true,
    );
  });

  it('emits one environment block, with the proxy switch the daemon insists on', () => {
    // Not a regex on a fragment: the failure this guards is a second `environment:` key, which is not valid
    // YAML and which docker rejects — and `docker compose config` cannot run here.
    const keys = rendered.split('environment:').length - 1;
    assert.equal(keys, 1, 'a service with two environment keys is not a valid compose file');
    assert.match(rendered, /NODE_USE_ENV_PROXY=1/, 'and the switch has to be there with the proxy variables');
  });
});

describe('the anchor flags, at the CLI boundary', () => {
  /**
   * Run the real command as a process.
   *
   * Every case here is refused by `fail`, which exits, so it cannot be a call into the module — and that is
   * the point of testing it here: the checks are the CLI's, and the unit tests under them never see them.
   */
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-pr-home-'));
  after(() => fs.rmSync(home, { recursive: true, force: true }));

  const cli = (args: readonly string[]): { status: number; stderr: string } => {
    try {
      execFileSync('node', ['src/cli/helper.ts', 'pr', ...args], {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // A test-owned HOME and no socket in the environment: the fallback must not depend on the machine
        // that runs the suite, and a case that gets past validation has to die at the socket rather than
        // reach a broker someone happens to have running.
        env: { ...process.env, HOME: home, GIT_BROKER_SOCKET: '', GIT_BROKER_SOCKET_FILE: '' },
      });
      return { status: 0, stderr: '' };
    } catch (error) {
      const failed = error as { status?: number | null; stderr?: string };
      return { status: failed.status ?? -1, stderr: String(failed.stderr ?? '') };
    }
  };

  const base = ['--host', 'github.com', '--repo', 'acme/widget', '--number', '7'];

  it('refuses half an anchor, in both directions', () => {
    const fileOnly = cli([...base, '--comment', '--file', 'Dockerfile', '--body', 'x']);
    assert.equal(fileOnly.status, 1, 'a file with no line is refused');
    assert.match(fileOnly.stderr, /both --file and --line/);

    const lineOnly = cli([...base, '--comment', '--line', '4', '--body', 'x']);
    assert.equal(lineOnly.status, 1, 'and a line with no file');
    assert.match(lineOnly.stderr, /both --file and --line/);
  });

  it('refuses an anchor on an action that is not a comment', () => {
    const closed = cli([...base, '--close', '--file', 'Dockerfile', '--line', '4', '--body', 'x']);
    assert.equal(closed.status, 1);
    assert.match(closed.stderr, /only go with --comment/);
  });

  it('refuses a side that is neither, and a line that is not a line', () => {
    const side = cli([...base, '--comment', '--file', 'Dockerfile', '--line', '4', '--side', 'middle', '--body', 'x']);
    assert.match(side.stderr, /--side must be left or right/);

    for (const line of ['0', 'x', '-1']) {
      const bad = cli([...base, '--comment', '--file', 'Dockerfile', '--line', line, '--body', 'x']);
      assert.equal(bad.status, 1, `--line ${line} is refused`);
      assert.match(bad.stderr, /--line must be a positive integer/);
    }
  });

  it('refuses --method unless the action merges', () => {
    const updated = cli([...base, '--method', 'squash', '--title', 'a title']);
    assert.equal(updated.status, 1);
    assert.match(updated.stderr, /only goes with --merge/);
  });

  it('refuses an edit with nothing to say, or with no comment to change', () => {
    const noBody = cli([...base, '--edit', '99']);
    assert.equal(noBody.status, 1, 'an edit with no body is refused');
    assert.match(noBody.stderr, /a comment has to say something/);

    for (const id of ['0', 'x', '-1']) {
      const bad = cli([...base, '--edit', id, '--body', 'a corrected note']);
      assert.equal(bad.status, 1, `--edit ${id} is refused`);
      assert.match(bad.stderr, /--edit needs the id of the review comment/);
    }
  });

  it('refuses a value flag given with no value, instead of updating the pull request', () => {
    // A bare --edit / --reply-to / --resolve is parsed as a boolean flag with no value, so the action
    // has to be selected from the flag's presence: reading only its value let the command fall through
    // to `update`, which patched the body meant for the comment onto the pull request itself.
    for (const [flag, message] of [
      ['--edit', /--edit needs the id of the review comment/],
      ['--reply-to', /--reply-to needs the id of the comment/],
      ['--resolve', /--resolve needs the id of the thread/],
    ] as const) {
      const refused = cli([...base, flag, '--body', 'a corrected note']);
      assert.equal(refused.status, 1, `a bare ${flag} is refused`);
      assert.match(refused.stderr, message);
    }
  });

  it('needs no --number to edit, which names the comment instead', () => {
    // The route is /pulls/comments/{id}: it carries no pull request number, so requiring one would be a
    // flag the command could not honour. This case gets past validation and dies at the socket, which is
    // exactly the proof that the number check let it through.
    const noNumber = cli([
      '--host', 'github.com', '--repo', 'acme/widget',
      '--edit', '99', '--body', 'a corrected note',
    ]);
    assert.equal(noNumber.status, 1);
    assert.match(noNumber.stderr, /no broker socket/, 'it reached socket resolution');
    assert.doesNotMatch(noNumber.stderr, /--number is required/, 'without being asked for a number');
  });
});
