/**
 * The host broker's own command path, driven end to end with a program that is not gh.
 *
 * The channel helpers are tested elsewhere; what this covers is the part that had none: a request
 * arriving, the argument list built for the program, the answer written back, and the two properties the
 * whole arrangement rests on — that the program is called without a shell, and that a repository is
 * either the checkout the request was written in or the explicit allowlisted repo it names.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { runBounded, runHostBroker } from '../../packages/host/src/commands/host.ts';
import { channelDir, listRequests, readResult, writeRequest } from '../../packages/core/src/host-request.ts';

describe('the host broker, once', () => {
  let root = '';
  let repo = '';
  let dir = '';
  let command = '';
  let argvFile = '';

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'host-broker-test-'));
    repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
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
      head: 'feat/thing',
      base: 'main',
      title: 'a title',
      body: 'a body',
      draft: true,
    });

    const code = await runHostBroker(['--repo', repo, '--command', command, '--once']);
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
    assert.ok(argv.includes('--title=a title'), 'one argument, spaces and all: no shell');
    assert.ok(argv.includes('--body-file'));
    assert.ok(
      !argv.includes('--repo'),
      'no explicit repository: the checkout still decides',
    );
  });

  it('refuses a request it would not be able to fulfil, and says why', async () => {
    const id = writeRequest(dir, { head: 'feat/ok', base: 'main', title: 'fine', body: '' });
    // A request that reaches the channel without going through the writer's checks.
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ head: '../escape', base: 'main', title: 'x', body: '' }));

    const code = await runHostBroker(['--repo', repo, '--command', command, '--once']);
    assert.equal(code, 0);
    assert.match(readResult(dir, id)?.error ?? '', /head branch/);
    assert.deepEqual(listRequests(dir), [], 'and it is dropped rather than retried forever');
  });
});

describe('bounded action output', () => {
  it('appends the timeout note when the child had already written stderr', async () => {
    const result = await runBounded(
      process.execPath,
      ['-e', 'process.stderr.write("before\\n" + "x".repeat(60000)); setTimeout(() => {}, 5000);'],
      { cwd: tmpdir(), env: process.env, timeoutMs: 500 },
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /before/u);
    assert.match(result.stderr, /\[output truncated\]/u);
    assert.match(result.stderr, /timed out; a write may have completed/u);
    assert.ok(Buffer.byteLength(result.stderr) <= 48_000);
  });

  it('omits the write caveat when writeCaveat is false', async () => {
    const result = await runBounded(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 5000);'],
      { cwd: tmpdir(), env: process.env, timeoutMs: 500, writeCaveat: false },
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /timed out/u);
    assert.doesNotMatch(result.stderr, /write may have completed/u);
  });
});

describe('the host reply route', () => {
  it('runs gh api for a review reply and returns the comment URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-reply-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const dir = channelDir(join(repo, '.git'));
    const config = forkConfig(root, 'acme/widget');
    const argvFile = join(root, 'argv');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > ' + argvFile + '\nprintf \'%s\\n\' \'{"html_url":"https://github.com/acme/widget/pull/7#discussion_r1"}\'\n',
      'utf8',
    );
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, {
        kind: 'reply',
        repo: 'acme/widget',
        number: 7,
        commentId: 123,
        body: 'a reply',
      });
      const code = await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      const answer = readResult(dir, id);
      assert.equal(answer?.number, 7);
      assert.equal(answer?.url, 'https://github.com/acme/widget/pull/7#discussion_r1');
      const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
      assert.deepEqual(argv.slice(0, 4), [
        'api',
        '--method',
        'POST',
        '/repos/acme/widget/pulls/7/comments/123/replies',
      ]);
      assert.equal(argv[argv.indexOf('--raw-field') + 1], 'body=a reply');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the host broker explicit-repository route', () => {
  it('passes an explicit repository to gh for a pull request too', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-pr-repo-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const argvFile = join(root, 'argv');
    const bodyCaptureFile = join(root, 'body');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > ' +
        argvFile +
        '\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--body-file" ]; then cat "$2" > ' +
        bodyCaptureFile +
        '; break; fi\n  shift\ndone\necho "https://github.com/acme/widget/pull/7"\n',
      'utf8',
    );
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, {
        repo: 'acme/widget',
        head: 'feat/x',
        base: 'main',
        title: 'a title',
        body: 'a body',
      });
      const code = await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      assert.equal(readResult(dir, id)?.number, 7);
      const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
      assert.equal(argv[argv.indexOf('--repo') + 1], 'acme/widget');
      assert.equal(readFileSync(bodyCaptureFile, 'utf8'), 'a body');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});

function forkConfig(root: string, allow: string, host = 'github.com'): string {
  const path = join(root, 'broker.config.yml');
  writeFileSync(
    path,
    `socketPath: ${join(root, 'broker.sock')}\nhosts:\n  ${host}:\n    provider: static\n    username: x\n    password: y\n    allow:\n      - ${allow}\n`,
    'utf8',
  );
  return path;
}

describe('the host broker fork route', () => {
  it('runs gh repo fork with the repository and returns its URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-fork-'));
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
      const id = writeRequest(dir, { kind: 'fork', repo: 'Acme/Widget', host: 'github.com' });
      const code = await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      assert.equal(readResult(dir, id)?.url, 'https://github.com/me/widget');
      assert.deepEqual(readFileSync(argvFile, 'utf8').trim().split('\n'), ['repo', 'fork', 'Acme/Widget']);
      assert.equal(readFileSync(envFile, 'utf8'), 'github.com|inherited-token');
    } finally {
      if (previousToken === undefined) delete process.env['GH_TOKEN'];
      else process.env['GH_TOKEN'] = previousToken;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('an existing fork', () => {
  it('turns gh\'s already-exists line into a URL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-fork-existing-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const envFile = join(root, 'env');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      `#!/bin/sh\nprintf '%s|%s' "$GH_HOST" "$GH_TOKEN" > ${envFile}\necho "me/widget already exists" >&2\nexit 0\n`,
      'utf8',
    );
    chmodSync(command, 0o755);
    const previousToken = process.env['GH_TOKEN'];
    const previousHost = process.env['GH_HOST'];
    try {
      process.env['GH_TOKEN'] = 'inherited-token';
      process.env['GH_HOST'] = 'enterprise.example';
      const id = writeRequest(dir, { kind: 'fork', repo: 'acme/widget' });
      const code = await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      assert.equal(readResult(dir, id)?.url, 'https://github.com/me/widget', 'a request with no host still reports the default');
      assert.equal(readFileSync(envFile, 'utf8'), 'github.com|inherited-token', 'and gh is forced to that host');
    } finally {
      if (previousToken === undefined) delete process.env['GH_TOKEN'];
      else process.env['GH_TOKEN'] = previousToken;
      if (previousHost === undefined) delete process.env['GH_HOST'];
      else process.env['GH_HOST'] = previousHost;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('an enterprise fork host', () => {
  it('keeps the token class gh uses for that host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-fork-ghes-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget', 'ghe.example');
    const dir = channelDir(join(repo, '.git'));
    const envFile = join(root, 'env');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      `#!/bin/sh\nprintf '%s|%s' "$GH_HOST" "$GH_ENTERPRISE_TOKEN" > ${envFile}\necho "me/widget already exists" >&2\nexit 0\n`,
      'utf8',
    );
    chmodSync(command, 0o755);
    const previous = process.env['GH_ENTERPRISE_TOKEN'];
    try {
      process.env['GH_ENTERPRISE_TOKEN'] = 'enterprise-token';
      const id = writeRequest(dir, { kind: 'fork', repo: 'acme/widget', host: 'ghe.example' });
      const code = await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      assert.equal(readResult(dir, id)?.url, 'https://ghe.example/me/widget');
      assert.equal(readFileSync(envFile, 'utf8'), 'ghe.example|enterprise-token');
    } finally {
      if (previous === undefined) delete process.env['GH_ENTERPRISE_TOKEN'];
      else process.env['GH_ENTERPRISE_TOKEN'] = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a fork outside the allowlist', () => {
  it('is refused before gh runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-fork-denied-'));
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
      const code = await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      assert.match(readResult(dir, id)?.error ?? '', /not in the allowlist/u);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a review whose temp directory cannot be made', () => {
  it('returns the setup failure instead of leaving the request claimed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-review-tmp-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const command = join(root, 'not-gh');
    writeFileSync(command, '#!/bin/sh\necho "{}"\n', 'utf8');
    chmodSync(command, 0o755);
    const blocked = join(root, 'not-a-directory');
    writeFileSync(blocked, 'x');
    const previous = process.env['TMPDIR'];
    try {
      process.env['TMPDIR'] = blocked;
      const id = writeRequest(dir, { kind: 'review', repo: 'acme/widget', number: 7, event: 'comment', body: 'hi' });
      const code = await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      assert.match(readResult(dir, id)?.error ?? '', /ENOTDIR|not a directory|failed/u);
      assert.deepEqual(listRequests(dir), [], 'the claimed request is not left behind');
    } finally {
      if (previous === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('edit routes outside the allowlist', () => {
  for (const kind of ['edit'] as const) {
    it(`refuses ${kind} before running gh`, async () => {
      const root = mkdtempSync(join(tmpdir(), `host-broker-${kind}-denied-`));
      const repo = join(root, 'checkout');
      mkdirSync(join(repo, '.git'), { recursive: true });
      writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      const config = forkConfig(root, 'other/repo');
      const dir = channelDir(join(repo, '.git'));
      const marker = join(root, 'ran');
      const command = join(root, 'not-gh');
      writeFileSync(command, '#!/bin/sh\ntouch ' + marker + '\necho "{}"\n', 'utf8');
      chmodSync(command, 0o755);
      try {
        const id = writeRequest(dir, { kind, repo: 'acme/widget', number: 7, title: 'fixed' });
        const code = await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']);
        assert.equal(code, 0);
        assert.match(readResult(dir, id)?.error ?? '', /not in the allowlist/u);
        assert.equal(existsSync(marker), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe('the host action route', () => {
  it('runs a catalogued action and returns its output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-action-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const argvFile = join(root, 'argv');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > ' + argvFile + '\necho "action output"\n',
      'utf8',
    );
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, {
        kind: 'action',
        action: 'issue:comment',
        repo: 'acme/widget',
        values: { number: 7, body: 'x' },
      });
      const code = await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      const result = readResult(dir, id);
      assert.equal(result?.stdout, 'action output\n');
      assert.equal(result?.code, 0);
      const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
      assert.deepEqual(argv.slice(0, 3), ['issue', 'comment', '7']);
      assert.equal(argv[argv.indexOf('--repo') + 1], 'acme/widget');
      assert.ok(argv.includes('--body-file'));
      assert.ok(argv[argv.indexOf('--body-file') + 1]?.endsWith('body.md'));

      writeFileSync(command, '#!/bin/sh\nyes a | head -c 60000\n', 'utf8');
      const largeId = writeRequest(dir, {
        kind: 'action',
        action: 'pr:view',
        repo: 'acme/widget',
        values: { number: 7 },
      });
      assert.equal(await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']), 0);
      const large = readResult(dir, largeId);
      assert.match(large?.stdout ?? '', /\[output truncated\]/u);
      assert.ok(Buffer.byteLength(large?.stdout ?? '') <= 48_000);

      const deniedId = writeRequest(dir, {
        kind: 'action',
        action: 'pr:view',
        repo: 'other/repo',
        values: { number: 7 },
      });
      assert.equal(await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']), 0);
      assert.match(readResult(dir, deniedId)?.error ?? '', /allowlist/u);

      const unknownId = writeRequest(dir, {
        kind: 'action',
        action: 'issue:delete',
        repo: 'acme/widget',
        values: { number: 7 },
      });
      assert.equal(await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']), 0);
      assert.match(readResult(dir, unknownId)?.error ?? '', /unknown gh action/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an asynchronous spawn error in the result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-spawn-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    try {
      const id = writeRequest(dir, {
        kind: 'action',
        action: 'pr:view',
        repo: 'acme/widget',
        values: { number: 7 },
      });
      assert.equal(
        await runHostBroker(['--repo', repo, '--command', join(root, 'missing-gh'), '--config', config, '--once']),
        0,
      );
      const result = readResult(dir, id);
      assert.equal(result?.code, 1);
      assert.match(result?.stderr ?? '', /ENOENT|spawn/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses issue:close when the number is a pull request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-issue-target-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const command = join(root, 'not-gh');
    writeFileSync(command, '#!/bin/sh\nif [ "$1" = "api" ]; then echo true; exit 0; fi\necho SHOULD_NOT_RUN\n', 'utf8');
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, {
        kind: 'action',
        action: 'issue:close',
        repo: 'acme/widget',
        values: { number: 7 },
      });
      assert.equal(await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']), 0);
      assert.match(readResult(dir, id)?.error ?? '', /pull request, not an issue/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a non-numeric issue number before the probe runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-issue-number-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const marker = join(root, 'ran');
    const command = join(root, 'not-gh');
    writeFileSync(command, '#!/bin/sh\ntouch ' + marker + '\n', 'utf8');
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, {
        kind: 'action',
        action: 'issue:close',
        repo: 'acme/widget',
        values: { number: 'nope' },
      });
      assert.equal(await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']), 0);
      assert.match(readResult(dir, id)?.error ?? '', /number/u);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when the issue-target probe fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-issue-probe-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const marker = join(root, 'ran');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      '#!/bin/sh\nif [ "$1" = "api" ]; then echo boom >&2; exit 1; fi\ntouch ' + marker + '\necho SHOULD_NOT_RUN\n',
      'utf8',
    );
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, {
        kind: 'action',
        action: 'issue:close',
        repo: 'acme/widget',
        values: { number: 7 },
      });
      assert.equal(await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']), 0);
      assert.match(readResult(dir, id)?.error ?? '', /boom/u);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses jq when the proxy URL contains credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-jq-proxy-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const marker = join(root, 'ran');
    const command = join(root, 'not-gh');
    writeFileSync(command, '#!/bin/sh\ntouch ' + marker + '\n', 'utf8');
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, {
        kind: 'action',
        action: 'issue:list',
        repo: 'acme/widget',
        values: { jq: '.' },
        proxy: 'http://user:secret@proxy.example:8080',
      });
      assert.equal(await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']), 0);
      assert.match(readResult(dir, id)?.error ?? '', /--jq cannot run/u);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs jq actions without the broker environment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-jq-env-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const command = join(root, 'not-gh');
    writeFileSync(command, '#!/bin/sh\nprintf "TOKEN=%s\\n" "$GH_TOKEN"\n', 'utf8');
    chmodSync(command, 0o755);
    const previous = process.env['GH_TOKEN'];
    process.env['GH_TOKEN'] = 'host-secret';
    try {
      const id = writeRequest(dir, {
        kind: 'action',
        action: 'issue:list',
        repo: 'acme/widget',
        values: { jq: '.', limit: 1 },
      });
      assert.equal(await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']), 0);
      assert.equal(readResult(dir, id)?.stdout, 'TOKEN=\n');
    } finally {
      if (previous === undefined) delete process.env['GH_TOKEN'];
      else process.env['GH_TOKEN'] = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a request the client already stopped waiting for', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-expired-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const marker = join(root, 'ran');
    const command = join(root, 'not-gh');
    writeFileSync(command, '#!/bin/sh\ntouch ' + marker + '\n', 'utf8');
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, {
        kind: 'action',
        action: 'pr:view',
        repo: 'acme/widget',
        values: { number: 7 },
      });
      const old = new Date(Date.now() - 10 * 60_000);
      utimesSync(join(dir, `${id}.json`), old, old);
      assert.equal(await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']), 0);
      assert.equal(existsSync(marker), false);
      assert.match(readResult(dir, id)?.error ?? '', /expired/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the host edit route', () => {
  it('runs gh pr edit with the supplied fields', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-edit-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const argvFile = join(root, 'argv');
    const bodyCaptureFile = join(root, 'body');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > ' +
        argvFile +
        '\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--body-file" ]; then cat "$2" > ' +
        bodyCaptureFile +
        '; break; fi\n  shift\ndone\necho "https://github.com/acme/widget/pull/7"\n',
      'utf8',
    );
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, {
        kind: 'edit',
        repo: 'acme/widget',
        number: 7,
        title: 'fixed',
        body: '--help',
      });
      const code = await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      assert.equal(readResult(dir, id)?.url, 'https://github.com/acme/widget/pull/7');
      const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
      assert.deepEqual(argv.slice(0, 2), ['pr', 'edit']);
      assert.equal(argv[argv.indexOf('--repo') + 1], 'acme/widget');
      assert.ok(argv.includes('--title=fixed'));
      assert.ok(argv.includes('--body-file'));
      assert.equal(readFileSync(bodyCaptureFile, 'utf8'), '--help');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the host review route', () => {
  it('runs gh pr review with the event and body file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-review-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'acme/widget');
    const dir = channelDir(join(repo, '.git'));
    const argvFile = join(root, 'argv');
    const bodyCaptureFile = join(root, 'body');
    const command = join(root, 'not-gh');
    writeFileSync(
      command,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > ' +
        argvFile +
        '\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--body-file" ]; then cat "$2" > ' +
        bodyCaptureFile +
        '; break; fi\n  shift\ndone\necho "https://github.com/acme/widget/pull/7#pullrequestreview-9"\n',
      'utf8',
    );
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, {
        kind: 'review',
        repo: 'acme/widget',
        number: 7,
        event: 'request-changes',
        body: 'please fix',
      });
      const code = await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      assert.equal(readResult(dir, id)?.url, 'https://github.com/acme/widget/pull/7#pullrequestreview-9');
      const argv = readFileSync(argvFile, 'utf8').trim().split('\n');
      assert.deepEqual(argv.slice(0, 2), ['pr', 'review']);
      assert.equal(argv[argv.indexOf('--repo') + 1], 'acme/widget');
      assert.ok(argv.includes('--request-changes'));
      assert.ok(argv.includes('--body-file'));
      assert.equal(readFileSync(bodyCaptureFile, 'utf8'), 'please fix');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a review outside the allowlist before gh runs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-review-denied-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'other/repo');
    const dir = channelDir(join(repo, '.git'));
    const marker = join(root, 'ran');
    const command = join(root, 'not-gh');
    writeFileSync(command, '#!/bin/sh\ntouch ' + marker + '\necho "{}"\n', 'utf8');
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, { kind: 'review', repo: 'acme/widget', number: 7, event: 'approve', body: '' });
      const code = await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      assert.match(readResult(dir, id)?.error ?? '', /not in the allowlist/u);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a reply outside the allowlist', () => {
  it('refuses before running gh', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-reply-denied-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const config = forkConfig(root, 'other/repo');
    const dir = channelDir(join(repo, '.git'));
    const marker = join(root, 'ran');
    const command = join(root, 'not-gh');
    writeFileSync(command, '#!/bin/sh\ntouch ' + marker + '\necho "{}"\n', 'utf8');
    chmodSync(command, 0o755);
    try {
      const id = writeRequest(dir, { kind: 'reply', repo: 'acme/widget', number: 7, commentId: 123, body: 'hi' });
      const code = await runHostBroker(['--repo', repo, '--command', command, '--config', config, '--once']);
      assert.equal(code, 0);
      assert.match(readResult(dir, id)?.error ?? '', /not in the allowlist/);
      assert.equal(existsSync(marker), false, 'gh never ran');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a claim that someone else holds', () => {
  it('does not act on the request, does not answer it, and does not remove the claim', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host broker-claim-'));
    const repo = join(root, 'checkout');
    mkdirSync(join(repo, '.git'), { recursive: true });
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

    const code = await runHostBroker(['--repo', repo, '--command', command, '--once']);
    assert.equal(code, 0);
    assert.equal(existsSync(argvFile), false, 'the program must not run: that request is not ours to fulfil');
    assert.equal(readResult(dir, id), undefined, 'and no answer is written for it');
    assert.ok(existsSync(claim), 'nor is a claim removed that this process does not hold');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('the host broker account selection', () => {
  it('uses ~/.config/gh-<login> and clears inherited tokens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-account-'));
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
      const code = await runHostBroker(['--repo', repo, '--command', command, '--once']);
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
    const root = mkdtempSync(join(tmpdir(), 'host-broker-account-shape-'));
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
    const code = await runHostBroker(['--repo', repo, '--command', command, '--once']);
    assert.equal(code, 0);
    assert.equal(readResult(dir, id), undefined);
    assert.equal(existsSync(envFile), false, 'the program must not run');
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses an account with no gh config directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-account-missing-'));
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
      const code = await runHostBroker(['--repo', repo, '--command', command, '--once']);
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

describe('the host broker proxy choice', () => {
  it('applies, keeps or clears the proxy environment per request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-broker-proxy-'));
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
        const code = await runHostBroker(['--repo', repo, '--command', command, '--once']);
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
