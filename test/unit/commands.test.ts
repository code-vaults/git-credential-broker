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
import { buildBrokerConfig, parsePermissions, performInit } from '../../src/commands/init.ts';
import { parseArgs, listFlag, insideMountedPath, mountedPaths } from '../../src/commands/support.ts';
import { performSetup } from '../../src/commands/setup.ts';

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
  it('knows what the container can see', () => {
    const home = '/home/app';
    assert.deepEqual(mountedPaths(home), ['/home/app/Workspaces', '/home/app/.dsh', '/home/app/.dotfiles']);
    assert.equal(insideMountedPath('/home/app/Workspaces/x', home), '/home/app/Workspaces');
    assert.equal(insideMountedPath('/home/app/.dsh/git-broker', home), '/home/app/.dsh');
    assert.equal(insideMountedPath('/volume1/docker/git-cred-broker', home), null);
    assert.equal(insideMountedPath('/home/app/Workspaces-evil', home), null, 'must not prefix-match a sibling');
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
      ...overrides,
    };
  }

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
});

describe('init', () => {
  /** A fake home, so the mount checks are hermetic rather than dependent on the machine. */
  const fakeHome = dir('init-home');
  const baseInput = {
    allow: ['acme/widget'],
    socketPath: '/run/git-broker/broker.sock',
    clientId: 'Iv1.example',
    appId: 123456,
    permissions: { contents: 'write' },
    force: false,
    // This suite runs inside the very container init refuses to run in, so the detected
    // environment is injected. The guard itself is exercised by the mount test below.
    env: { isInsideContainer: () => false, home: fakeHome },
  };

  it('installs the key 0600 and writes a config the daemon accepts', () => {
    const root = dir(`init-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));

    const result = performInit({ ...baseInput, cert, dir: path.join(root, 'deploy') });

    assert.equal(fs.statSync(result.keyPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(result.configPath).mode & 0o777, 0o600);
    assert.equal(result.config.hosts['github.com']?.allow[0], 'acme/widget');
    assert.equal(result.config.socketPath, '/run/git-broker/broker.sock');
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
    const mounted = path.join(fakeHome, 'Workspaces', 'somewhere');
    assert.throws(
      () => performInit({ ...baseInput, cert, dir: mounted }),
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

  it('will not overwrite an existing config unless forced', () => {
    const root = dir(`init-force-${Math.random().toString(36).slice(2)}`);
    const cert = writeKey(path.join(root, 'downloaded.pem'));
    const target = path.join(root, 'deploy');
    performInit({ ...baseInput, cert, dir: target });
    assert.throws(() => performInit({ ...baseInput, cert, dir: target }), /already exists/);
    assert.doesNotThrow(() => performInit({ ...baseInput, cert, dir: target, force: true }));
  });

  it('parses permission lists and rejects malformed ones', () => {
    assert.deepEqual(parsePermissions(undefined), { contents: 'write' });
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
          socketPath: '',
        }),
      /socketPath is required/,
    );
  });
});

describe('compose', () => {
  const rendered = renderCompose({
    dir: '/volume1/docker/git-cred-broker',
    socketDir: '/volume1/homes/u/Workspaces/h/.dsh/git-broker',
    user: '1026:100',
    socketPath: '/run/git-broker/broker.sock',
    image: 'node:24-slim',
    packageSpec: 'git-credential-broker@0.1.0',
    name: 'git-cred-broker',
  });

  it('mounts the key read-only and publishes no ports', () => {
    assert.match(rendered, /app\.pem:\/etc\/git-cred-broker\/app\.pem:ro/);
    assert.match(rendered, /config\.json:\/etc\/git-cred-broker\/config\.json:ro/);
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
    assert.match(rendered, /socketDir.*|.*:\/run\/git-broker/);
  });
});
