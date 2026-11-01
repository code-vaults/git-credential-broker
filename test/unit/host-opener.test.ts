/**
 * The opener's own command path, driven end to end with a program that is not gh.
 *
 * The channel helpers are tested elsewhere; what this covers is the part that had none: a request
 * arriving, the argument list built for the program, the answer written back, and the two properties the
 * whole arrangement rests on — that the program is called without a shell, and that the repository is the
 * checkout the request was written in rather than anything the request asked for.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { runHostOpener } from '../../packages/host/src/commands/host-opener.ts';
import { channelDir, listRequests, readResult, writeRequest } from '../../packages/core/src/host-request.ts';

describe('the opener, once', () => {
  let root = '';
  let repo = '';
  let dir = '';
  let command = '';
  let argvFile = '';

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'host-opener-test-'));
    repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    dir = channelDir(join(repo, '.git'));
    // A program that records what it was called with, and answers the way gh does.
    command = join(root, 'not-gh');
    argvFile = join(root, 'argv');
    writeFileSync(
      command,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${argvFile}\necho "https://github.com/acme/widget/pull/7"\n`,
      'utf8',
    );
    chmodSync(command, 0o755);
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fulfils a request, records the answer, and passes on what it was asked to', async () => {
    const id = writeRequest(dir, {
      repo: 'someone/else',
      head: 'feat/thing',
      base: 'main',
      title: 'a title',
      body: 'a body',
      draft: true,
    });

    const code = await runHostOpener(['--repo', repo, '--command', command, '--once']);
    assert.equal(code, 0);

    const answer = readResult(dir, id);
    assert.equal(answer?.number, 7);
    assert.equal(answer?.url, 'https://github.com/acme/widget/pull/7');
    assert.deepEqual(listRequests(dir), [], 'and the request is consumed, not left to be fulfilled twice');

    const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
    assert.deepEqual(argv.slice(0, 2), ['pr', 'create']);
    assert.ok(argv.includes('--draft'), 'the draft flag reaches the program');
    assert.equal(argv[argv.indexOf('--head') + 1], 'feat/thing');
    assert.equal(argv[argv.indexOf('--base') + 1], 'main');
    assert.equal(argv[argv.indexOf('--title') + 1], 'a title', 'one argument, spaces and all: no shell');
    assert.ok(argv.includes('--body-file'));
    assert.ok(
      !argv.includes('--repo'),
      'and never the repository the request named: the checkout decides, so a request cannot aim it elsewhere',
    );
  });

  it('refuses a request it would not be able to fulfil, and says why', async () => {
    const id = writeRequest(dir, { head: 'feat/ok', base: 'main', title: 'fine', body: '' });
    // A request that reaches the channel without going through the writer's checks.
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ head: '../escape', base: 'main', title: 'x', body: '' }));

    const code = await runHostOpener(['--repo', repo, '--command', command, '--once']);
    assert.equal(code, 0);
    assert.match(readResult(dir, id)?.error ?? '', /head branch/);
    assert.deepEqual(listRequests(dir), [], 'and it is dropped rather than retried forever');
  });
});

describe('the opener issue route', () => {
  it('runs gh issue create without branch flags', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-opener-issue-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const dir = channelDir(join(repo, '.git'));
    const argvFile = join(root, 'argv');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > ' + argvFile + '\necho "https://github.com/acme/widget/issues/9"\n',
      'utf8',
    );
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, { kind: 'issue', title: 'a title', body: 'a body' });
      const code = await runHostOpener(['--repo', repo, '--command', command, '--once']);
      assert.equal(code, 0);
      assert.equal(readResult(dir, id)?.number, 9);
      const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
      assert.deepEqual(argv.slice(0, 2), ['issue', 'create']);
      assert.equal(argv[argv.indexOf('--title') + 1], 'a title');
      assert.ok(argv.includes('--body-file'));
      assert.ok(!argv.includes('--base'));
      assert.ok(!argv.includes('--head'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function forkConfig(root: string, allow: string): string {
  const path = join(root, 'broker.config.yml');
  writeFileSync(
    path,
    `socketPath: ${join(root, 'broker.sock')}\nhosts:\n  github.com:\n    provider: static\n    username: x\n    password: y\n    allow:\n      - ${allow}\n`,
    'utf8',
  );
  return path;
}

describe('the opener fork route', () => {
  it('runs gh repo fork with the repository and returns its URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-opener-fork-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const argvFile = join(root, 'argv');
    const envFile = join(root, 'env');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > ' +
        argvFile +
        '\nprintf \'%s|%s\' "$GH_HOST" "$GH_TOKEN" > ' +
        envFile +
        '\necho "https://github.com/me/widget"\n',
      'utf8',
    );
    chmodSync(command, 0o755);
    const previousToken = process.env['GH_TOKEN'];
    try {
      process.env['GH_TOKEN'] = 'inherited-token';
      const id = writeRequest(dir, { kind: 'fork', repo: 'acme/widget', host: 'github.com' });
      const code = await runHostOpener(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      assert.equal(readResult(dir, id)?.url, 'https://github.com/me/widget');
      assert.deepEqual(readFileSync(argvFile, 'utf8').trim().split('\n'), ['repo', 'fork', 'acme/widget']);
      assert.equal(readFileSync(envFile, 'utf8'), 'github.com|');
    } finally {
      if (previousToken === undefined) delete process.env['GH_TOKEN'];
      else process.env['GH_TOKEN'] = previousToken;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('an existing fork', () => {
  it('turns gh\'s already-exists line into a URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-opener-fork-existing-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const command = join(root, 'not-gh');
    writeFileSync(command, '#!/bin/sh\necho "me/widget already exists" >&2\nexit 0\n', 'utf8');
    chmodSync(command, 0o755);
    const previousToken = process.env['GH_TOKEN'];
    try {
      process.env['GH_TOKEN'] = 'inherited-token';
      const id = writeRequest(dir, { kind: 'fork', repo: 'acme/widget', host: 'github.com' });
      const code = await runHostOpener(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      assert.equal(readResult(dir, id)?.url, 'https://github.com/me/widget');
    } finally {
      if (previousToken === undefined) delete process.env['GH_TOKEN'];
      else process.env['GH_TOKEN'] = previousToken;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a fork outside the allowlist', () => {
  it('is refused before gh runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-opener-fork-denied-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'other/repo');
    const dir = channelDir(join(repo, '.git'));
    const marker = join(root, 'ran');
    const command = join(root, 'not-gh');
    writeFileSync(command, `#!/bin/sh\ntouch ${marker}\n`, 'utf8');
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, { kind: 'fork', repo: 'acme/widget', host: 'github.com' });
      const code = await runHostOpener(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      assert.match(readResult(dir, id)?.error ?? '', /not in the allowlist/u);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a claim that someone else holds', () => {
  it('does not act on the request, does not answer it, and does not remove the claim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'opener-claim-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const dir = channelDir(join(repo, '.git'));
    const argvFile = join(root, 'argv');
    const command = join(root, 'not-gh');
    writeFileSync(command, `#!/bin/sh\nprintf '%s\\n' "$@" > ${argvFile}\necho "https://github.com/acme/widget/pull/7"\n`, 'utf8');
    chmodSync(command, 0o755);

    const id = writeRequest(dir, { head: 'feat/thing', base: 'main', title: 'a title', body: '' });
    // One mkdir, which is all the container needs to make the rename fail: the claim is not taken.
    const claim = join(dir, `${id}.json.working`);
    mkdirSync(claim, { recursive: true });

    const code = await runHostOpener(['--repo', repo, '--command', command, '--once']);
    assert.equal(code, 0);
    assert.equal(existsSync(argvFile), false, 'the program must not run: that request is not ours to fulfil');
    assert.equal(readResult(dir, id), undefined, 'and no answer is written for it');
    assert.ok(existsSync(claim), 'nor is a claim removed that this process does not hold');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('the opener account selection', () => {
  it('uses ~/.config/gh-<login> and clears inherited tokens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-opener-account-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const dir = channelDir(join(repo, '.git'));
    const envFile = join(root, 'env');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      '#!/bin/sh\nprintf \'%s|%s|%s|%s|%s|%s\\n\' "$GH_CONFIG_DIR" "${GH_TOKEN-}" "${GITHUB_TOKEN-}" "${GH_ENTERPRISE_TOKEN-}" "${GITHUB_ENTERPRISE_TOKEN-}" "${GH_HOST-}" > ' +
        envFile +
        '\necho "https://github.com/acme/widget/pull/7"\n',
      'utf8',
    );
    chmodSync(command, 0o755);
    const configDir = join(root, '.config', 'gh-alice');
    mkdirSync(configDir, { recursive: true });
    const previous = {
      HOME: process.env['HOME'],
      GH_TOKEN: process.env['GH_TOKEN'],
      GITHUB_TOKEN: process.env['GITHUB_TOKEN'],
      GH_ENTERPRISE_TOKEN: process.env['GH_ENTERPRISE_TOKEN'],
      GITHUB_ENTERPRISE_TOKEN: process.env['GITHUB_ENTERPRISE_TOKEN'],
      GH_HOST: process.env['GH_HOST'],
    };
    process.env['HOME'] = root;
    process.env['GH_TOKEN'] = 'inherited';
    process.env['GITHUB_TOKEN'] = 'inherited';
    process.env['GH_ENTERPRISE_TOKEN'] = 'inherited';
    process.env['GITHUB_ENTERPRISE_TOKEN'] = 'inherited';
    process.env['GH_HOST'] = 'enterprise.example';
    try {
      const id = writeRequest(dir, { head: 'feat/ok', base: 'main', title: 'x', body: '', account: 'alice' });
      const code = await runHostOpener(['--repo', repo, '--command', command, '--once']);
      assert.equal(code, 0);
      assert.equal(readResult(dir, id)?.error, undefined);
      assert.equal(readFileSync(envFile, 'utf8').trim(), configDir + '|||||');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a request whose account is not a string', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-opener-account-shape-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const dir = channelDir(join(repo, '.git'));
    const envFile = join(root, 'env');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      '#!/bin/sh\nprintf ran > ' + envFile + '\necho "https://github.com/acme/widget/pull/7"\n',
      'utf8',
    );
    chmodSync(command, 0o755);
    const id = writeRequest(dir, { head: 'feat/ok', base: 'main', title: 'x', body: '' });
    writeFileSync(
      join(dir, id + '.json'),
      JSON.stringify({ head: 'feat/ok', base: 'main', title: 'x', body: '', account: ['alice'] }),
    );
    const code = await runHostOpener(['--repo', repo, '--command', command, '--once']);
    assert.equal(code, 0);
    assert.equal(readResult(dir, id), undefined);
    assert.equal(existsSync(envFile), false, 'the program must not run');
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses an account with no gh config directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-opener-account-missing-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const dir = channelDir(join(repo, '.git'));
    const envFile = join(root, 'env');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      '#!/bin/sh\nprintf ran > ' + envFile + '\necho "https://github.com/acme/widget/pull/7"\n',
      'utf8',
    );
    chmodSync(command, 0o755);
    const configRoot = join(root, '.config');
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(join(configRoot, 'gh-file'), '');
    const previousHome = process.env['HOME'];
    process.env['HOME'] = root;
    try {
      const ghost = writeRequest(dir, { head: 'feat/ok', base: 'main', title: 'x', body: '', account: 'ghost' });
      const file = writeRequest(dir, { head: 'feat/ok', base: 'main', title: 'x', body: '', account: 'file' });
      const code = await runHostOpener(['--repo', repo, '--command', command, '--once']);
      assert.equal(code, 0);
      assert.match(readResult(dir, ghost)?.error ?? '', /no gh config for account "ghost"/);
      assert.match(readResult(dir, file)?.error ?? '', /no gh config for account "file"/);
      assert.equal(existsSync(envFile), false, 'the program must not run');
    } finally {
      if (previousHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the opener proxy choice', () => {
  it('applies, keeps or clears the proxy environment per request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-opener-proxy-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const dir = channelDir(join(repo, '.git'));
    const envFile = join(root, 'env');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      `#!/bin/sh\nprintf '%s|%s|%s|%s\\n' "$HTTP_PROXY" "$HTTPS_PROXY" "$NO_PROXY" "$NODE_USE_ENV_PROXY" > ${envFile}\necho "https://github.com/acme/widget/pull/7"\n`,
      'utf8',
    );
    chmodSync(command, 0o755);
    const previous = {
      HTTP_PROXY: process.env['HTTP_PROXY'],
      HTTPS_PROXY: process.env['HTTPS_PROXY'],
      NO_PROXY: process.env['NO_PROXY'],
      NODE_USE_ENV_PROXY: process.env['NODE_USE_ENV_PROXY'],
    };
    process.env['HTTP_PROXY'] = 'http://host-env:1';
    process.env['HTTPS_PROXY'] = 'http://host-env:1';
    process.env['NO_PROXY'] = 'host';
    process.env['NODE_USE_ENV_PROXY'] = '1';
    try {
      for (const proxy of [undefined, 'http://proxy.example:7890', null] as const) {
        const id = writeRequest(dir, { head: 'feat/ok', base: 'main', title: 'x', body: '', proxy });
        const code = await runHostOpener(['--repo', repo, '--command', command, '--once']);
        assert.equal(code, 0);
        assert.equal(readResult(dir, id)?.error, undefined);
        const seen = readFileSync(envFile, 'utf8').trim();
        if (proxy === undefined) assert.equal(seen, 'http://host-env:1|http://host-env:1|host|1');
        else if (proxy === null) assert.equal(seen, '|||');
        else assert.equal(seen, 'http://proxy.example:7890|http://proxy.example:7890|localhost,127.0.0.1|');
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
