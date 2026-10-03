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
    env: { isInsideContainer: () => false, home: fakeHome },
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
      env: { isInsideContainer: () => false, home: dir('discovery-home') },
    });

    assert.equal(result.configPath, custom);
    assert.equal(fs.existsSync(custom), true);
    assert.equal(fs.existsSync(path.join(root, 'deploy', 'broker.config.json')), false, 'and not in --dir as well');
  });
});

describe('compose', () => {
  const rendered = renderCompose({
    dir: '/volume1/docker/git-cred-broker',
    socketDir: '/volume1/homes/u/Workspaces/h/.dsh/git-broker',
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
      socketDir: '/volume1/homes/u/Workspaces/h/.dsh/git-broker',
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
      rendered.includes('/volume1/homes/u/Workspaces/h/.dsh/git-broker:' + SIDECAR.socketDir),
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
  const cli = (args: readonly string[]): { status: number; stderr: string } => {
    try {
      execFileSync('node', ['src/cli/helper.ts', 'pr', ...args], {
        cwd: path.resolve('.'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
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
});
