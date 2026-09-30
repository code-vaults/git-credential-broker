/**
 * `stage`: exporting the broker from a commit into a directory the agent cannot write.
 *
 * The guard rails are the point of the command, so they are what is tested: the target must be
 * outside every container mount, must not be the deployment directory (which holds the key), and
 * must not silently absorb uncommitted working-tree edits.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { performStage, STAGED_RECORD } from '../../src/commands/stage.ts';

/** Scratch space. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-stage-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/**
 * A throwaway repository with one commit.
 *
 * @param name - the directory to create it in.
 * @returns its path.
 */
function makeRepo(name: string): string {
  const repo = path.join(scratch, name);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'daemon.ts'), 'export const version = 1;\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first');
  return repo;
}

describe('stage', () => {
  it('exports the commit, records where it came from, and ignores the working tree', () => {
    const repo = makeRepo('clean');
    const to = path.join(scratch, 'staged/clean');

    // An uncommitted edit that must NOT reach the staged tree.
    fs.writeFileSync(path.join(repo, 'src', 'daemon.ts'), 'export const version = 999;\n');

    const result = performStage({ repo, to, ref: 'HEAD', home: scratch });

    assert.equal(result.dirtyWorkingTree, true, 'the dirty tree is reported');
    assert.equal(result.files > 0, true);
    assert.match(fs.readFileSync(path.join(to, 'src', 'daemon.ts'), 'utf8'), /version = 1/, 'the committed content');
    const record = JSON.parse(fs.readFileSync(path.join(to, STAGED_RECORD), 'utf8')) as { sha: string; subject: string };
    assert.equal(record.sha, result.sha);
    assert.equal(record.subject, 'first');
  });

  it('replaces a tree it staged before, leaving nothing stale behind', () => {
    const repo = makeRepo('restage');
    const to = path.join(scratch, 'staged/restage');

    performStage({ repo, to, ref: 'HEAD', home: scratch });
    fs.writeFileSync(path.join(repo, 'src', 'old.ts'), 'export const gone = true;\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'second'], {
      cwd: repo,
    });
    performStage({ repo, to, ref: 'HEAD', home: scratch });

    assert.equal(fs.existsSync(path.join(to, 'src', 'old.ts')), true, 'the new commit added it');

    // Now delete it in a third commit: the staged tree must not keep a file that no longer exists.
    fs.rmSync(path.join(repo, 'src', 'old.ts'));
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'third'], {
      cwd: repo,
    });
    performStage({ repo, to, ref: 'HEAD', home: scratch });
    assert.equal(fs.existsSync(path.join(to, 'src', 'old.ts')), false, 'no stale file survives a restage');
  });

  it('refuses a target inside a container mount', () => {
    const repo = makeRepo('mounted');
    const home = path.join(scratch, 'home');
    const inside = path.join(home, 'Workspaces', 'somewhere');
    fs.mkdirSync(inside, { recursive: true });

    assert.throws(
      () => performStage({ repo, to: inside, ref: 'HEAD', home }),
      /mounted into the container/,
      'code the agent can rewrite must never be staged where it will run with the key',
    );
  });

  it('refuses to clear the deployment directory that holds the key', () => {
    const repo = makeRepo('deployment');
    const to = path.join(scratch, 'deployment-dir');
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, 'app.pem'), 'the key\n');
    fs.writeFileSync(path.join(to, 'broker.config.json'), '{}\n');

    assert.throws(() => performStage({ repo, to, ref: 'HEAD', home: scratch, force: true }), /deployment directory/);
    assert.equal(fs.readFileSync(path.join(to, 'app.pem'), 'utf8'), 'the key\n', 'the key is untouched');
  });

  it('refuses an unrelated non-empty target unless forced', () => {
    const repo = makeRepo('nonempty');
    const to = path.join(scratch, 'not-ours');
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, 'something.txt'), 'mine\n');

    assert.throws(() => performStage({ repo, to, ref: 'HEAD', home: scratch }), /not ours to clear/);
    assert.equal(fs.existsSync(path.join(to, 'something.txt')), true, 'nothing was removed');
  });

  it('refuses a target that overlaps the repository', () => {
    const repo = makeRepo('overlap');
    assert.throws(() => performStage({ repo, to: repo, ref: 'HEAD', home: scratch }), /overlap/);
    assert.throws(
      () => performStage({ repo, to: path.join(repo, 'dist'), ref: 'HEAD', home: scratch }),
      /overlap/,
    );
  });
});
