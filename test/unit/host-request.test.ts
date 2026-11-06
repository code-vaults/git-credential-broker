/**
 * The request channel, and the one thing the host broker reads out of a program's output.
 *
 * The channel is two processes talking through a directory, so these tests are about the file
 * protocol: what a request looks like, what is refused before it is written, and what a caller sees
 * while it waits.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { pullRequestUrl } from '../../packages/host/src/commands/host.ts';
import {
  channelDir,
  claimRequest,
  reclaimAbandoned,
  clearHostBroker,
  discoverCheckouts,
  findGitDir,
  listRequests,
  newId,
  readHostBroker,
  readRequest,
  readResult,
  removeRequest,
  removeResult,
  requestProblems,
  waitForResult,
  writeHostBroker,
  writeRequest,
  writeResult,
} from '../../packages/core/src/host-request.ts';

/** A good request, which each test varies one field of. */
const GOOD = { head: 'feat/thing', base: 'main', title: 'a title', body: 'a body' };

describe('what the channel refuses to read', () => {
  it('does not read a marker that is not a regular file, which is what a FIFO would be', () => {
    const root = mkdtempSync(join(tmpdir(), 'channel-kind-'));
    const dir = channelDir(join(root, '.git'));
    mkdirSync(dir, { recursive: true });
    // A directory is the non-regular file a test can make without blocking; readJson now rejects it
    // after an O_NONBLOCK, O_NOFOLLOW open rather than by lstat.
    mkdirSync(join(dir, 'host-broker.json'), { recursive: true });
    assert.equal(readHostBroker(dir), undefined, 'a directory is not a marker');
    rmSync(root, { recursive: true, force: true });
  });

  it('does not treat a symlinked .git as a checkout, because the container can make one', () => {
    const root = mkdtempSync(join(tmpdir(), 'channel-link-'));
    const target = mkdtempSync(join(tmpdir(), 'channel-target-'));
    writeFileSync(join(target, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const repo = join(root, 'checkout');
    mkdirSync(repo, { recursive: true });
    symlinkSync(target, join(repo, '.git'));
    assert.equal(findGitDir(repo), undefined, 'a link names a path the container chose');
    rmSync(root, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });
});

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

  it('advertises a running host broker, and forgets it when it stops', () => {
    assert.equal(readHostBroker(dir), undefined, 'nothing is running to begin with');

    writeHostBroker(dir, { pid: 4321, command: 'gh', startedAt: '2026-10-01T00:00:00.000Z' });
    assert.deepEqual(readHostBroker(dir), { pid: 4321, command: 'gh', startedAt: '2026-10-01T00:00:00.000Z' });

    clearHostBroker(dir);
    assert.equal(readHostBroker(dir), undefined);
  });

  it('carries a request to the host broker and an answer back', async () => {
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

  it('keeps a large control-character answer readable', () => {
    const id = writeRequest(dir, GOOD);
    writeResult(dir, id, { stdout: '\u0000'.repeat(200_000), stderr: '', code: 0 });
    const answer = readResult(dir, id);
    assert.ok(answer, 'the answer is readable');
    assert.match(answer.stdout ?? '', /\[output truncated\]/u);
    removeRequest(dir, id);
    removeResult(dir, id);
  });

  it('keeps the marker and the answers out of the list of work to do', () => {
    writeHostBroker(dir, { pid: 1 });
    writeResult(dir, '20261001T000000-0000', { error: 'nope' });

    assert.deepEqual(listRequests(dir), [], 'neither is a request');

    clearHostBroker(dir);
    removeResult(dir, '20261001T000000-0000');
  });

  it('refuses what the host broker would refuse, before writing anything', () => {
    assert.deepEqual(requestProblems(GOOD), []);
    assert.match(requestProblems({ ...GOOD, head: '../escape' }).join(' '), /head branch/);
    assert.match(requestProblems({ ...GOOD, base: 'a..b' }).join(' '), /base branch/);
    assert.match(requestProblems({ ...GOOD, base: 'feat/thing' }).join(' '), /same branch/);
    assert.match(requestProblems({ ...GOOD, title: '   ' }).join(' '), /title/);
    assert.match(requestProblems({ ...GOOD, body: 'x'.repeat(70_000) }).join(' '), /body/);
    assert.deepEqual(requestProblems({ ...GOOD, account: 'octocat' }), []);
    assert.match(requestProblems({ ...GOOD, account: 'not a login' }).join(' '), /account/);
    assert.match(requestProblems({ ...GOOD, repo: 'not a repo' }).join(' '), /repository/);

    assert.throws(() => writeRequest(dir, { ...GOOD, head: '../escape' }), /head branch/);
    assert.deepEqual(listRequests(dir), [], 'and a refused request is not waiting');
  });

  it('carries a typed review reply', async () => {
    const reply = {
      kind: 'reply' as const,
      repo: 'acme/widget',
      number: 7,
      commentId: 123,
      body: 'a reply',
      account: 'octocat',
    };
    assert.deepEqual(requestProblems(reply), []);
    assert.match(requestProblems({ ...reply, commentId: 0 }).join(' '), /comment id/);
    assert.match(requestProblems({ ...reply, body: '   ' }).join(' '), /reply needs a body/);
    const id = writeRequest(dir, reply);
    assert.deepEqual(readRequest(dir, id), {
      ...reply,
      session: undefined,
      pid: undefined,
    });
    removeRequest(dir, id);
  });

  it('refuses unsafe request numbers', () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    assert.match(
      requestProblems({ kind: 'review', repo: 'acme/widget', number: unsafe, event: 'approve', body: '' }).join(' '),
      /number is not positive/u,
    );
  });

  it('refuses an edit with nothing to change', () => {
    assert.throws(
      () => writeRequest(dir, { kind: 'edit', repo: 'acme/widget', number: 7 }),
      /edit needs a title, body or base/u,
    );
    assert.deepEqual(listRequests(dir), [], 'and neither is waiting');
  });

  it('carries a fork request without branches or text', async () => {
    const fork = { kind: 'fork' as const, repo: 'acme/widget', account: 'octocat' };
    assert.deepEqual(requestProblems(fork), []);
    assert.match(requestProblems({ ...fork, repo: 'not a repo' }).join(' '), /repository/);
    assert.match(requestProblems({ ...fork, host: 'evil/path' }).join(' '), /host/);
    const rawId = newId();
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, rawId + '.json'),
      JSON.stringify({ v: 1, id: rawId, kind: 'fork', repo: 'acme/widget', host: 'evil.example/x#' }),
    );
    assert.equal(claimRequest(dir, rawId), undefined, 'a hand-written invalid host is not claimed');
    const id = writeRequest(dir, fork);
    const read = readRequest(dir, id);
    assert.equal(read?.kind, 'fork');
    assert.equal(read !== undefined && read.kind === 'fork' ? read.repo : undefined, 'acme/widget');
    removeRequest(dir, id);
  });

  it('reclaims a claim whose process is gone', () => {
    const id = writeRequest(dir, GOOD);
    assert.ok(claimRequest(dir, id));
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.ok(dead.pid !== undefined);
    writeFileSync(join(dir, `${id}.claim`), JSON.stringify({ pid: dead.pid, at: Date.now() }));
    assert.deepEqual(reclaimAbandoned(dir), [id]);
    assert.ok(listRequests(dir).includes(id), 'the request is back in the queue');
    assert.equal(existsSync(join(dir, `${id}.json.working`)), false);
    removeRequest(dir, id);
  });

  it('leaves a claim alone while another reclaimer holds the lock', () => {
    const id = writeRequest(dir, GOOD);
    assert.ok(claimRequest(dir, id));
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.ok(dead.pid !== undefined);
    writeFileSync(join(dir, `${id}.claim`), JSON.stringify({ pid: dead.pid, at: Date.now() }));
    writeFileSync(join(dir, `${id}.reclaim`), String(process.pid));
    assert.deepEqual(reclaimAbandoned(dir), []);
    assert.equal(existsSync(join(dir, `${id}.json.working`)), true);
    rmSync(join(dir, `${id}.reclaim`));
    assert.deepEqual(reclaimAbandoned(dir), [id]);
    removeRequest(dir, id);
  });

  it('does not requeue a completed request after the client consumed the result', () => {
    const id = writeRequest(dir, GOOD);
    assert.ok(claimRequest(dir, id));
    writeResult(dir, id, { stdout: 'ok', stderr: '', code: 0 });
    removeResult(dir, id);
    assert.deepEqual(reclaimAbandoned(dir), [id]);
    assert.equal(listRequests(dir).includes(id), false);
    assert.equal(readResult(dir, id), undefined);
  });

  it('ignores a malformed reclaim counter', () => {
    const id = writeRequest(dir, GOOD);
    assert.ok(claimRequest(dir, id));
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.ok(dead.pid !== undefined);
    writeFileSync(join(dir, `${id}.claim`), JSON.stringify({ pid: dead.pid, at: Date.now() }));
    writeFileSync(join(dir, `${id}.reclaims`), JSON.stringify('not-a-number'));
    assert.deepEqual(reclaimAbandoned(dir), [id]);
    assert.ok(listRequests(dir).includes(id));
    removeRequest(dir, id);
  });

  it('starts the no-record age at the claim, not at the original request', () => {
    const id = writeRequest(dir, GOOD);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(dir, `${id}.json`), old, old);
    assert.ok(claimRequest(dir, id));
    rmSync(join(dir, `${id}.claim`));
    assert.deepEqual(reclaimAbandoned(dir), []);
    removeRequest(dir, id);
  });

  it('does not reclaim a young claim whose sidecar is missing', () => {
    const id = writeRequest(dir, GOOD);
    assert.ok(claimRequest(dir, id));
    rmSync(join(dir, `${id}.claim`));
    assert.deepEqual(reclaimAbandoned(dir), []);
    assert.ok(existsSync(join(dir, `${id}.json.working`)));
    removeRequest(dir, id);
  });

  it('does not write through a symlinked claim sidecar', () => {
    const id = writeRequest(dir, GOOD);
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'untouched');
    symlinkSync(target, join(dir, `${id}.claim`));
    assert.ok(claimRequest(dir, id));
    assert.equal(readFileSync(target, 'utf8'), 'untouched');
    removeRequest(dir, id);
    rmSync(target, { force: true });
  });

  it('resets a requeued request to eligible age', () => {
    const id = writeRequest(dir, GOOD);
    assert.ok(claimRequest(dir, id));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(dir, `${id}.json.working`), old, old);
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.ok(dead.pid !== undefined);
    writeFileSync(join(dir, `${id}.claim`), JSON.stringify({ pid: dead.pid, at: Date.now() }));
    assert.deepEqual(reclaimAbandoned(dir), [id]);
    assert.ok(Date.now() - statSync(join(dir, `${id}.json`)).mtimeMs < 2_000);
    removeRequest(dir, id);
  });

  it('reclaims an unrecorded claim once it is old enough', () => {
    const id = writeRequest(dir, GOOD);
    assert.ok(claimRequest(dir, id));
    rmSync(join(dir, `${id}.claim`));
    const old = new Date(Date.now() - 3_601_000);
    utimesSync(join(dir, `${id}.json.working`), old, old);
    assert.deepEqual(reclaimAbandoned(dir), [id]);
    removeRequest(dir, id);
  });

  it('reclaims an old claim even when its pid is alive, and stops after two', () => {
    const id = writeRequest(dir, GOOD);
    assert.ok(claimRequest(dir, id));
    writeFileSync(
      join(dir, `${id}.claim`),
      JSON.stringify({ pid: process.pid, at: Date.now() - 2 * 60 * 60_000 - 1 }),
    );
    assert.deepEqual(reclaimAbandoned(dir), [id]);

    assert.ok(claimRequest(dir, id));
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.ok(dead.pid !== undefined);
    writeFileSync(join(dir, `${id}.claim`), JSON.stringify({ pid: dead.pid, at: Date.now() }));
    assert.deepEqual(reclaimAbandoned(dir), [id]);
    assert.match(readResult(dir, id)?.error ?? '', /reclaimed twice/u);
    assert.equal(listRequests(dir).includes(id), false);
    removeResult(dir, id);
  });

  it('leaves a live claim alone and retires an answered one', () => {
    const id = writeRequest(dir, GOOD);
    assert.ok(claimRequest(dir, id));
    assert.deepEqual(reclaimAbandoned(dir), [], 'the claimant is this process');
    assert.ok(existsSync(join(dir, `${id}.json.working`)));

    writeResult(dir, id, { stdout: 'ok', stderr: '', code: 0 });
    assert.deepEqual(reclaimAbandoned(dir), [id]);
    assert.equal(existsSync(join(dir, `${id}.json.working`)), false);
    assert.equal(readResult(dir, id)?.stdout, 'ok');
    removeResult(dir, id);
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
    assert.equal(readRequest(dir, 'broken'), undefined, 'so the host broker drops it instead of guessing');
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
  it('finds the checkouts within the given depth, hidden directories included', () => {
    const root = mkdtempSync(join(tmpdir(), 'discover-test-'));
    for (const repo of ['.hidden', 'trees/one', 'trees/two/deep', 'plain']) {
      mkdirSync(join(root, repo, '.git'), { recursive: true });
      writeFileSync(join(root, repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      writeFileSync(join(root, repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    }
    // never descended into, and never enough on its own
    mkdirSync(join(root, 'trees/one/node_modules/decoy/.git'), { recursive: true });
    writeFileSync(join(root, 'trees/one/node_modules/decoy/.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    writeFileSync(join(root, 'trees/one/node_modules/decoy/.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    mkdirSync(join(root, 'trees/three/four/five/six/seven/.git'), { recursive: true });
    writeFileSync(join(root, 'trees/three/four/five/six/seven/.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    writeFileSync(join(root, 'trees/three/four/five/six/seven/.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    const repos = discoverCheckouts(root, 4)
      .map((found) => found.repo.slice(root.length + 1))
      .sort();
    assert.deepEqual(repos, ['.hidden', 'plain', 'trees/one', 'trees/two/deep']);

    rmSync(root, { recursive: true, force: true });
  });

  it('serves a worktree whose git directory is spelled through an alias of the root', () => {
    // The root can be one name for a directory the filesystem knows by another ($HOME on the host this was
    // found on), and a worktree records its git directory under the real one. Comparing the raw spellings
    // served the plain checkout and silently skipped the worktree beside it.
    const base = mkdtempSync(join(tmpdir(), 'discover-alias-'));
    const real = join(base, 'real');
    mkdirSync(join(real, 'checkout', 'worktree'), { recursive: true });
    mkdirSync(join(real, 'gitdir'), { recursive: true });
    writeFileSync(join(real, 'gitdir', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    writeFileSync(join(real, 'checkout', 'worktree', '.git'), `gitdir: ${join(real, 'gitdir')}\n`, 'utf8');
    mkdirSync(join(real, 'plain', '.git'), { recursive: true });
    writeFileSync(join(real, 'plain', '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    const alias = join(base, 'alias');
    symlinkSync(real, alias, 'junction');

    try {
      const repos = discoverCheckouts(alias, 4)
        .map((found) => found.repo.slice(alias.length + 1))
        .sort();
      assert.deepEqual(repos, ['checkout/worktree', 'plain']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
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

describe('a checkout the container has aimed elsewhere', () => {
  it('does not follow a symlink out of the root to find a git directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'symlink-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'symlink-outside-'));
    writeFileSync(join(outside, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');

    // The reported attack: a link inside the checkout, and a pointer at the link. The lexical path is under
    // the root, so only the real path can tell that the directory is not.
    const repo = join(root, 'checkout');
    mkdirSync(repo, { recursive: true });
    symlinkSync(outside, join(repo, 'x'));
    writeFileSync(join(repo, '.git'), 'gitdir: x\n', 'utf8');

    assert.deepEqual(discoverCheckouts(root), [], 'nothing under the root may point outside it');
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
