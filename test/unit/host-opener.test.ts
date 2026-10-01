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

import { runHostOpener } from '../../src/commands/host-opener.ts';
import { channelDir, listRequests, readResult, writeRequest } from '../../src/host-request.ts';

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
