/**
 * The request channel, and the one thing the opener reads out of a program's output.
 *
 * The channel is two processes talking through a directory, so these tests are about the file
 * protocol: what a request looks like, what is refused before it is written, and what a caller sees
 * while it waits.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { pullRequestUrl } from '../../src/commands/host-opener.ts';
import {
  channelDir,
  clearOpener,
  discoverCheckouts,
  findGitDir,
  listRequests,
  newId,
  readOpener,
  readRequest,
  readResult,
  removeRequest,
  removeResult,
  requestProblems,
  waitForResult,
  writeOpener,
  writeRequest,
  writeResult,
} from '../../src/host-request.ts';

/** A good request, which each test varies one field of. */
const GOOD = { head: 'feat/thing', base: 'main', title: 'a title', body: 'a body' };

describe('the host request channel', () => {
  let root = '';
  let dir = '';

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'host-request-test-'));
  });

  // A channel per test: a failure in one must not leave a request behind for the next to trip over.
  beforeEach(() => {
    dir = channelDir(join(mkdtempSync(join(root, 'case-')), '.git'));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the git directory from a subdirectory', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const nested = join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });

    assert.equal(findGitDir(nested), join(root, '.git'));
    assert.equal(findGitDir(tmpdir()), undefined);
  });

  it('advertises a running opener, and forgets it when it stops', () => {
    assert.equal(readOpener(dir), undefined, 'nothing is running to begin with');

    writeOpener(dir, { pid: 4321, command: 'gh', startedAt: '2026-10-01T00:00:00.000Z' });
    assert.deepEqual(readOpener(dir), { pid: 4321, command: 'gh', startedAt: '2026-10-01T00:00:00.000Z' });

    clearOpener(dir);
    assert.equal(readOpener(dir), undefined);
  });

  it('carries a request to the opener and an answer back', async () => {
    const id = writeRequest(dir, GOOD);

    assert.deepEqual(listRequests(dir), [id], 'and it is the only thing waiting');
    assert.deepEqual(readRequest(dir, id), {
      repo: undefined,
      draft: false,
      ...GOOD,
      session: undefined,
      pid: undefined,
    });

    writeResult(dir, id, { number: 7, url: 'https://github.com/acme/widget/pull/7' });
    const answer = await waitForResult(dir, id, 1_000, 10);

    assert.equal(answer?.number, 7);
    assert.equal(answer?.url, 'https://github.com/acme/widget/pull/7');

    removeRequest(dir, id);
    removeResult(dir, id);
    assert.deepEqual(listRequests(dir), []);
    assert.equal(readResult(dir, id), undefined, 'and nothing is left behind');
  });

  it('keeps the marker and the answers out of the list of work to do', () => {
    writeOpener(dir, { pid: 1 });
    writeResult(dir, '20261001T000000-0000', { error: 'nope' });

    assert.deepEqual(listRequests(dir), [], 'neither is a request');

    clearOpener(dir);
    removeResult(dir, '20261001T000000-0000');
  });

  it('refuses what the opener would refuse, before writing anything', () => {
    assert.deepEqual(requestProblems(GOOD), []);
    assert.match(requestProblems({ ...GOOD, head: '../escape' }).join(' '), /head branch/);
    assert.match(requestProblems({ ...GOOD, base: 'a..b' }).join(' '), /base branch/);
    assert.match(requestProblems({ ...GOOD, base: 'feat/thing' }).join(' '), /same branch/);
    assert.match(requestProblems({ ...GOOD, title: '   ' }).join(' '), /title/);
    assert.match(requestProblems({ ...GOOD, body: 'x'.repeat(70_000) }).join(' '), /body/);

    assert.throws(() => writeRequest(dir, { ...GOOD, head: '../escape' }), /head branch/);
    assert.deepEqual(listRequests(dir), [], 'and a refused request is not waiting');
  });

  it('names a request after the clock, with something to break a tie', () => {
    // The shape is the contract. Whether two calls in the same millisecond differ is luck, and a
    // test that depends on luck is a test that goes red for the wrong reason.
    assert.match(newId(new Date('2026-10-01T01:02:03.456Z')), /^20261001010203456-[0-9a-f]{4}$/);
  });

  it('reports no answer rather than waiting forever', async () => {
    const started = Date.now();
    assert.equal(await waitForResult(dir, 'never-answered', 60, 10), undefined);
    assert.ok(Date.now() - started >= 50, 'it waited out the timeout');
  });

  it('survives a request file that is not a request', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{oops', 'utf8');
    assert.deepEqual(listRequests(dir), ['broken']);
    assert.equal(readRequest(dir, 'broken'), undefined, 'so the opener drops it instead of guessing');
    removeRequest(dir, 'broken');
  });
});

describe('reading a pull request URL out of a program', () => {
  it('takes the URL gh prints', () => {
    assert.deepEqual(pullRequestUrl('https://github.com/acme/widget/pull/12\n'), {
      number: 12,
      url: 'https://github.com/acme/widget/pull/12',
    });
  });

  it('takes it out of chatter around it', () => {
    const output = 'Warning: 3 uncommitted changes\nCreating pull request for feat/x into main\nhttps://github.com/acme/widget/pull/9\n';
    assert.equal(pullRequestUrl(output)?.number, 9);
  });

  it('reports nothing rather than guessing', () => {
    assert.equal(pullRequestUrl(''), undefined);
    assert.equal(pullRequestUrl('a pull request for acme/widget'), undefined);
  });
});

describe('finding the checkouts to serve', () => {
  it('finds every checkout under a root, at any depth, dotfiles included', () => {
    const root = mkdtempSync(join(tmpdir(), 'discover-test-'));
    for (const repo of ['.dotfiles', 'Workspaces/one', 'Workspaces/two/deep', 'plain']) {
      mkdirSync(join(root, repo, '.git'), { recursive: true });
      writeFileSync(join(root, repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      writeFileSync(join(root, repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    }
    // never descended into, and never enough on its own
    mkdirSync(join(root, 'Workspaces/one/node_modules/decoy/.git'), { recursive: true });
    writeFileSync(join(root, 'Workspaces/one/node_modules/decoy/.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    writeFileSync(join(root, 'Workspaces/one/node_modules/decoy/.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    mkdirSync(join(root, 'Workspaces/three/four/five/six/seven/.git'), { recursive: true });
    writeFileSync(join(root, 'Workspaces/three/four/five/six/seven/.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    writeFileSync(join(root, 'Workspaces/three/four/five/six/seven/.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const repos = discoverCheckouts(root, 4)
      .map((found) => found.repo.slice(root.length + 1))
      .sort();
    assert.deepEqual(repos, ['.dotfiles', 'Workspaces/one', 'Workspaces/two/deep', 'plain']);

    rmSync(root, { recursive: true, force: true });
  });

  it('returns a channel directory per checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'discover-test-'));
    mkdirSync(join(root, 'a', '.git'), { recursive: true });
    writeFileSync(join(root, 'a', '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    writeFileSync(join(root, 'a', '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const [only] = discoverCheckouts(root, 1);
    assert.equal(only?.dir, channelDir(join(root, 'a', '.git')));

    rmSync(root, { recursive: true, force: true });
  });
});
