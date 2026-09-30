/**
 * Tests for the authorization policy — in particular the two ways an allowlist is usually
 * defeated: prefix matching, and path normalization drift.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hostConfig, normalizeRepoPath, parseAllowEntry, repoAllowed } from '../../src/policy.ts';
import type { BrokerConfig } from '../../src/types.ts';

describe('normalizeRepoPath', () => {
  it('accepts what git actually sends and strips the .git suffix', () => {
    assert.deepEqual(normalizeRepoPath('acme/widget.git'), {
      owner: 'acme',
      repo: 'widget',
      full: 'acme/widget',
    });
  });

  it('lowercases, because GitHub owner and repository names are case-insensitive', () => {
    assert.equal(normalizeRepoPath('Acme/Widget.GIT')?.full, 'acme/widget');
  });

  it('tolerates a leading slash and a trailing slash', () => {
    assert.equal(normalizeRepoPath('/acme/widget/')?.full, 'acme/widget');
    assert.equal(normalizeRepoPath('/acme/widget.git/')?.full, 'acme/widget');
  });

  it('keeps a leading dot in a repository name such as .github', () => {
    assert.equal(normalizeRepoPath('acme/.github.git')?.full, 'acme/.github');
  });

  it('rejects anything that is not exactly two segments', () => {
    for (const value of ['', 'acme', 'acme/widget/extra', '/', 'acme//widget', undefined, null, 42]) {
      assert.equal(normalizeRepoPath(value), null, `expected null for ${JSON.stringify(value)}`);
    }
  });

  it('rejects traversal, dot-only segments, and characters a repository name cannot contain', () => {
    for (const value of [
      '../etc/passwd',
      'acme/..',
      'acme/.',
      'acme/...',
      'acme/wid get',
      'acme/wid%2fget',
      'acme/wid;get',
    ]) {
      assert.equal(normalizeRepoPath(value), null, `expected null for ${JSON.stringify(value)}`);
    }
  });
});

describe('parseAllowEntry', () => {
  it('accepts exact entries and whole-segment wildcards', () => {
    assert.deepEqual(parseAllowEntry('acme/widget'), { owner: 'acme', repo: 'widget' });
    assert.deepEqual(parseAllowEntry('ACME/*'), { owner: 'acme', repo: '*' });
  });

  it('rejects malformed entries so that they match nothing', () => {
    for (const value of ['acme', 'acme/widget/extra', 'acme/wid*', '*', '', 7]) {
      assert.equal(parseAllowEntry(value), null, `expected null for ${JSON.stringify(value)}`);
    }
  });
});

describe('repoAllowed', () => {
  it('allows exactly what is listed', () => {
    assert.equal(repoAllowed(['acme/widget'], 'acme/widget'), true);
    assert.equal(repoAllowed(['acme/widget'], 'acme/other'), false);
  });

  it('never allows a repository that merely starts with an allowed name', () => {
    assert.equal(repoAllowed(['acme/widget'], 'acme/widget-evil'), false);
    assert.equal(repoAllowed(['acme/widget'], 'acme/widget2'), false);
  });

  it('supports a whole-segment wildcard for one owner', () => {
    assert.equal(repoAllowed(['acme/*'], 'acme/anything'), true);
    assert.equal(repoAllowed(['acme/*'], 'other/anything'), false);
  });

  it('is default deny for an empty or malformed allowlist', () => {
    assert.equal(repoAllowed([], 'acme/widget'), false);
    assert.equal(repoAllowed(undefined, 'acme/widget'), false);
    assert.equal(repoAllowed(['garbage'], 'acme/widget'), false);
  });
});

describe('hostConfig', () => {
  const config = {
    socketPath: '/tmp/x.sock',
    socketMode: 0o660,
    auditPath: null,
    tokenCacheSkewSeconds: 300,
    hosts: {
      'github.com': { provider: 'static', allow: ['acme/widget'] },
      '127.0.0.1:8080': { provider: 'static', allow: ['acme/widget'] },
    },
  } satisfies BrokerConfig;

  it('matches case-insensitively and keeps the configured spelling', () => {
    assert.equal(hostConfig(config, 'GitHub.com')?.host, 'github.com');
  });

  it('matches a host with a port, as git reports non-default ports', () => {
    assert.equal(hostConfig(config, '127.0.0.1:8080')?.host, '127.0.0.1:8080');
  });

  it('defaults to deny for an unknown host', () => {
    assert.equal(hostConfig(config, 'evil.example'), null);
    assert.equal(hostConfig(config, ''), null);
    assert.equal(hostConfig(config, undefined), null);
  });
});
