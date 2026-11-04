/**
 * The primary adapter is the one dispatch seam: catalogued subcommands go through it, and only a
 * selected primary decides how the action runs.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { runClient } from '../../packages/client/src/index.ts';
import { primaryFromEnv, type Primary } from '../../packages/client/src/primary.ts';
import { tryRunAsync } from '../common/run.ts';

const CLIENT_BIN = fileURLToPath(new URL('../../packages/client/bin/gcb.js', import.meta.url));

function recorder(): { primary: Primary; calls: { argv: readonly string[]; identity?: string }[] } {
  const calls: { argv: readonly string[]; identity?: string }[] = [];
  return {
    calls,
    primary: {
      name: 'fake',
      run: async (argv, options) => {
        calls.push({ argv, identity: options?.identity });
        return 7;
      },
    },
  };
}

describe('the primary dispatch seam', () => {
  it('sends pr and issue catalogue actions through the selected primary', async () => {
    const pr = recorder();
    assert.equal(await runClient(['pr', 'view', '1', '--repo', 'acme/widget'], pr.primary), 7);
    assert.deepEqual(pr.calls[0]?.argv, ['pr', 'view', '1', '--repo', 'acme/widget']);

    const issue = recorder();
    assert.equal(
      await runClient(['issue', 'edit', '7', '--title', 't', '--repo', 'acme/widget'], issue.primary),
      7,
    );
    assert.deepEqual(issue.calls[0]?.argv, ['issue', 'edit', '7', '--title', 't', '--repo', 'acme/widget']);
  });

  it('strips a bare --as-user and selects the user identity', async () => {
    const issue = recorder();
    assert.equal(
      await runClient(
        ['issue', 'comment', '7', '--body', 'note', '--as-user', '--repo', 'acme/widget'],
        issue.primary,
      ),
      7,
    );
    assert.deepEqual(issue.calls[0]?.argv, ['issue', 'comment', '7', '--body', 'note', '--repo', 'acme/widget']);
    assert.equal(issue.calls[0]?.identity, 'user');
  });

  it('selects the configured primary from a registry', () => {
    const fake = recorder().primary;
    assert.equal(primaryFromEnv({ GCB_PRIMARY: 'fake' }, { gh: fake, fake }), fake);
  });

  it('leaves built-in routes independent of the primary', async () => {
    for (const args of [
      ['pr', '--help'],
      ['pr', 'view', '--help'],
      ['issue', 'edit', '--help'],
      ['run', '--help'],
    ]) {
      const result = await tryRunAsync(
        process.execPath,
        ['--conditions=development', CLIENT_BIN, ...args],
        { env: { ...process.env, GCB_PRIMARY: 'glab' }, timeoutMs: 5_000 },
      );
      assert.equal(result.status, 0, args.join(' '));
    }
  });

  it('does not let a bad primary block person or host routes', async () => {
    for (const args of [
      ['pr', '--number', '1', '--approve', '--repo', 'acme/widget'],
      ['pr', 'create', '--as-user', 'alice', '--head', 'h', '--title', 't', '--body', 'b', '--repo', 'acme/widget'],
    ]) {
      const result = await tryRunAsync(
        process.execPath,
        ['--conditions=development', CLIENT_BIN, ...args],
        { env: { ...process.env, GCB_PRIMARY: 'glab' }, timeoutMs: 5_000 },
      );
      assert.doesNotMatch(result.stderr, /unsupported primary/u, args.join(' '));
    }
  });

  it('fails closed for an unsupported configured primary', async () => {
    const result = await tryRunAsync(
      process.execPath,
      ['--conditions=development', CLIENT_BIN, 'pr', 'view', '1', '--repo', 'acme/widget'],
      { env: { ...process.env, GCB_PRIMARY: 'glab' }, timeoutMs: 5_000 },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsupported primary "glab"/u);
  });
});
