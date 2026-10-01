/**
 * Resolving a branch that names a remote, against a real repository with real remotes.
 *
 * A mock here would test the mock: what matters is that `git remote get-url` is what decides, and that a
 * name which is not a remote fails with the ones that are — that list is the whole point of preferring a
 * remote name over a hand-typed repository.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { listRemotes, qualifiedBranch, remoteRepo } from '../../src/commands/remotes.ts';

describe('resolving a branch that names a remote', () => {
  let dir = '';

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'remotes-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('remote', 'add', 'origin', 'git@github.com:me/git-credential-broker.git');
    git('remote', 'add', 'upstream', 'https://github.com/code-vaults/git-credential-broker.git');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads an SSH url and an HTTPS one the same way', () => {
    assert.deepEqual(remoteRepo('origin', dir), { owner: 'me', repo: 'git-credential-broker' });
    assert.deepEqual(remoteRepo('upstream', dir), { owner: 'code-vaults', repo: 'git-credential-broker' });
  });

  it('leaves a plain branch alone, because it is a branch of the repository --repo names', () => {
    assert.equal(qualifiedBranch('feat/thing', dir), 'feat/thing');
    assert.equal(qualifiedBranch('main', dir), 'main');
  });

  it('turns a remote name into the owner GitHub expects', () => {
    assert.equal(qualifiedBranch('origin:feat/thing', dir), 'me:feat/thing');
    assert.equal(qualifiedBranch('upstream:main', dir), 'code-vaults:main');
  });

  it('lists what exists when the name is wrong, which is what a remote name buys', () => {
    assert.throws(
      () => qualifiedBranch('origion:feat/thing', dir),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /no remote named "origion"/);
        assert.match(message, /origin, upstream/, 'and it names the ones this checkout has');
        return true;
      },
    );
  });

  it('lists the remotes in the order git does', () => {
    assert.deepEqual(listRemotes(dir), ['origin', 'upstream']);
  });
});

describe('what a remote URL is allowed to look like', () => {
  let dir = '';

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'remotes-forms-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    git('remote', 'add', 'ported', 'https://git.example.com:8443/me/thing.git');
    git('remote', 'add', 'prefixed', 'https://git.example.com/gitlab/group/thing.git');
    git('remote', 'add', 'local', '/srv/git/thing.git');
    git('remote', 'add', 'files', 'file:///srv/git/thing.git');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not read a port as an owner', () => {
    assert.deepEqual(remoteRepo('ported', dir), { owner: 'me', repo: 'thing' });
  });

  it('does not read a directory as a host', () => {
    assert.equal(remoteRepo('local', dir), undefined);
    assert.equal(remoteRepo('files', dir), undefined);
  });

  it('refuses a URL with more path than owner/repo, and says which remote it was', () => {
    assert.equal(remoteRepo('prefixed', dir), undefined);
    assert.throws(
      () => qualifiedBranch('prefixed:main', dir),
      /remote "prefixed" points at .*gitlab\/group\/thing\.git/,
      'the operator is told the URL, not that the remote does not exist',
    );
  });
});
