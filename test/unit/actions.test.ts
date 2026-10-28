import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ActionError,
  GH_ACTION_NAMES,
  GH_ACTIONS,
  buildGhArgv,
  getGhAction,
} from '../../packages/cli/src/actions.ts';
import { MAX_BODY_CHARS, MAX_TITLE_CHARS } from '../../packages/cli/src/host-request.ts';

describe('gh action catalog', () => {
  it('has the roadmap actions and no merge action', () => {
    assert.deepEqual(GH_ACTION_NAMES, [
      'pr:view',
      'pr:list',
      'pr:diff',
      'pr:create',
      'pr:edit',
      'pr:close',
      'pr:comment',
      'pr:review',
      'issue:create',
      'run:view',
      'run:list',
    ]);
    assert.equal('pr:merge' in GH_ACTIONS, false);
    assert.equal(getGhAction('pr:create').command.join(' '), 'pr create');
    assert.equal(getGhAction('pr:close').command.join(' '), 'pr close');
  });

  it('keeps creation token permissions narrow', () => {
    assert.deepEqual(getGhAction('pr:create').permissions, {
      pull_requests: 'write',
      contents: 'read',
    });
    assert.deepEqual(getGhAction('issue:create').permissions, { issues: 'write' });
  });
});

describe('buildGhArgv', () => {
  it('rebuilds the canonical argv and injects the repository', () => {
    assert.deepEqual(
      buildGhArgv(
        'pr:create',
        {
          head: 'feat/x',
          base: 'main',
          title: 'A title',
          body: 'A body',
          draft: true,
          label: ['one', 'two'],
        },
        'acme/widget',
      ),
      [
        'pr',
        'create',
        '--head',
        'feat/x',
        '--base',
        'main',
        '--title',
        'A title',
        '--body',
        'A body',
        '--draft',
        '--label',
        'one',
        '--label',
        'two',
        '--repo',
        'acme/widget',
      ],
    );
  });

  it('accepts a numeric positional as a number or a digit string', () => {
    assert.deepEqual(buildGhArgv('pr:view', { number: 42 }, 'acme/widget'), [
      'pr',
      'view',
      '42',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('pr:view', { number: '42', comments: true }, 'acme/widget'), [
      'pr',
      'view',
      '42',
      '--comments',
      '--repo',
      'acme/widget',
    ]);
  });

  it('builds the edit flags', () => {
    assert.deepEqual(
      buildGhArgv('pr:edit', { number: 7, title: 't', base: 'main' }, 'acme/widget'),
      ['pr', 'edit', '7', '--title', 't', '--base', 'main', '--repo', 'acme/widget'],
    );
  });

  it('accepts numeric flag values without stringifying them first', () => {
    assert.deepEqual(buildGhArgv('pr:list', { limit: 10 }, 'acme/widget'), [
      'pr',
      'list',
      '--limit',
      '10',
      '--repo',
      'acme/widget',
    ]);
  });

  it('omits false booleans', () => {
    assert.deepEqual(
      buildGhArgv('pr:view', { number: 1, comments: false }, 'acme/widget'),
      ['pr', 'view', '1', '--repo', 'acme/widget'],
    );
  });

  it('refuses unknown keys, inherited action names and malformed repositories', () => {
    assert.throws(() => buildGhArgv('pr:view', { number: 1, web: true }, 'acme/widget'), ActionError);
    assert.throws(() => buildGhArgv('pr:merge', {}, 'acme/widget'), /unknown gh action/);
    assert.throws(() => buildGhArgv('constructor', {}, 'acme/widget'), /unknown gh action/);
    assert.throws(() => buildGhArgv('pr:view', { number: 1 }, '../widget'), /invalid repository/);
  });

  it('requires the values gh would otherwise prompt for', () => {
    assert.throws(
      () => buildGhArgv('pr:create', { head: 'feat/x', title: 't' }, 'acme/widget'),
      /--body/,
    );
    assert.throws(
      () => buildGhArgv('pr:create', { title: 't', body: 'b' }, 'acme/widget'),
      /--head/,
    );
    assert.throws(
      () => buildGhArgv('pr:comment', { number: 1 }, 'acme/widget'),
      /--body/,
    );
  });

  it('requires exactly one review mode', () => {
    assert.throws(
      () => buildGhArgv('pr:review', { number: 1, body: 'ok' }, 'acme/widget'),
      /exactly one/,
    );
    assert.throws(
      () => buildGhArgv('pr:review', { number: 1, approve: true, comment: true }, 'acme/widget'),
      /exactly one/,
    );
    assert.throws(
      () => buildGhArgv('pr:review', { number: 1, comment: true }, 'acme/widget'),
      /--body with --comment/,
    );
    assert.throws(
      () => buildGhArgv('pr:review', { number: 1, comment: true, body: '' }, 'acme/widget'),
      /non-empty/,
    );
    assert.throws(
      () => buildGhArgv('pr:review', { number: 1, 'request-changes': true, body: '  ' }, 'acme/widget'),
      /non-empty/,
    );
    assert.deepEqual(
      buildGhArgv('pr:review', { number: 1, approve: true, body: 'ok' }, 'acme/widget'),
      ['pr', 'review', '1', '--approve', '--body', 'ok', '--repo', 'acme/widget'],
    );
  });

  it('refuses wrong types instead of coercing them', () => {
    assert.throws(() => buildGhArgv('pr:view', { number: '1.5' }, 'acme/widget'), /positive integer/);
    assert.throws(() => buildGhArgv('pr:view', { number: 1, json: 1 }, 'acme/widget'), /must be a string/);
    assert.throws(
      () => buildGhArgv('pr:list', { label: [1] as unknown as string[] }, 'acme/widget'),
      /list of strings/,
    );
  });
});

describe('action value limits', () => {
  it('accepts the exact title/body limits and refuses one more', () => {
    assert.doesNotThrow(() =>
      buildGhArgv(
        'issue:create',
        { title: 'x'.repeat(MAX_TITLE_CHARS), body: '' },
        'acme/widget',
      ),
    );
    assert.throws(
      () => buildGhArgv('issue:create', { title: 'x'.repeat(MAX_TITLE_CHARS + 1), body: '' }, 'acme/widget'),
      /at most 256 characters/,
    );
    assert.doesNotThrow(() =>
      buildGhArgv('pr:comment', { number: 1, body: 'x'.repeat(MAX_BODY_CHARS) }, 'acme/widget'),
    );
    assert.throws(
      () => buildGhArgv('pr:comment', { number: 1, body: 'x'.repeat(MAX_BODY_CHARS + 1) }, 'acme/widget'),
      /at most 65536 characters/,
    );
  });
});

describe('action title content', () => {
  it('refuses an empty or whitespace-only title', () => {
    for (const title of ['', '   ', '\n\t']) {
      assert.throws(
        () => buildGhArgv('issue:create', { title, body: '' }, 'acme/widget'),
        /must not be empty/,
      );
    }
  });
});
