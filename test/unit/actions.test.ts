import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ActionError,
  GH_ACTION_NAMES,
  GH_ACTIONS,
  buildGhArgv,
  getGhAction,
} from '../../packages/core/src/actions.ts';
import { MAX_BODY_CHARS, MAX_TITLE_CHARS } from '../../packages/core/src/host-request.ts';

describe('gh action catalog', () => {
  it('has the roadmap actions and no merge action', () => {
    assert.deepEqual(GH_ACTION_NAMES, [
      'pr:view',
      'pr:list',
      'pr:diff',
      'pr:create',
      'pr:edit',
      'pr:close',
      'pr:reopen',
      'pr:ready',
      'pr:lock',
      'pr:unlock',
      'pr:update-branch',
      'pr:checks',
      'pr:status',
      'pr:comment',
      'pr:comment-edit',
      'pr:comment-delete',
      'pr:review',
      'pr:review-by-id',
      'issue:create',
      'issue:edit',
      'issue:comment',
      'issue:comment-edit',
      'issue:comment-delete',
      'issue:close',
      'issue:reopen',
      'issue:lock',
      'issue:unlock',
      'issue:pin',
      'issue:unpin',
      'issue:view',
      'issue:list',
      'run:view',
      'run:list',
      'run:watch',
      'run:cancel',
      'run:rerun',
      'release:list',
      'release:view',
      'workflow:list',
      'workflow:view',
      'label:list',
      'label:create',
      'label:edit',
      'label:delete',
    ]);
    assert.equal('pr:merge' in GH_ACTIONS, false);
    assert.equal(getGhAction('pr:create').command.join(' '), 'pr create');
    assert.equal(getGhAction('pr:close').command.join(' '), 'pr close');
  });

  it('declares the close/reopen identity and timeout policy', () => {
    for (const name of ['pr:reopen', 'issue:close', 'issue:reopen']) {
      assert.equal(getGhAction(name).timeoutSeconds, 60, name);
    }
    assert.equal(getGhAction('pr:reopen').appUser, undefined);
    assert.equal(getGhAction('issue:close').appUser, true);
    assert.equal(getGhAction('issue:reopen').appUser, true);
    assert.equal(getGhAction('issue:close').target, 'issue');
    assert.equal(getGhAction('issue:reopen').target, 'issue');
    assert.deepEqual(getGhAction('pr:reopen').permissions, { pull_requests: 'write' });
    assert.deepEqual(getGhAction('issue:close').permissions, { issues: 'write' });
    assert.deepEqual(getGhAction('issue:reopen').permissions, { issues: 'write' });
  });

  it('keeps creation token permissions narrow', () => {
    assert.deepEqual(getGhAction('pr:create').permissions, {
      pull_requests: 'write',
      contents: 'read',
    });
    assert.deepEqual(getGhAction('issue:create').permissions, { issues: 'write' });
  });

  it('declares the read-side policy', () => {
    assert.deepEqual(getGhAction('pr:checks').permissions, {
      pull_requests: 'read',
      checks: 'read',
      statuses: 'read',
    });
    assert.deepEqual(getGhAction('pr:status').permissions, {
      pull_requests: 'read',
      checks: 'read',
      statuses: 'read',
    });
    assert.deepEqual(getGhAction('issue:view').permissions, { issues: 'read' });
    assert.deepEqual(getGhAction('issue:list').permissions, { issues: 'read' });
    assert.deepEqual(getGhAction('issue:comment-edit').permissions, { issues: 'write' });
    assert.equal(getGhAction('issue:comment-edit').command.join(' '), 'issue comment-edit');
    assert.deepEqual(getGhAction('pr:comment-edit').permissions, { pull_requests: 'write' });
    assert.equal(getGhAction('pr:comment').appUser, true);
    assert.equal(getGhAction('pr:comment-edit').appUser, true);
    assert.equal(getGhAction('pr:comment-edit').command.join(' '), 'pr comment-edit');
    assert.deepEqual(getGhAction('issue:comment-delete').permissions, { issues: 'write' });
    assert.deepEqual(getGhAction('pr:comment-delete').permissions, { pull_requests: 'write' });
    assert.equal(getGhAction('issue:comment-delete').appUser, true);
    assert.equal(getGhAction('pr:comment-delete').appUser, true);
    assert.equal(getGhAction('issue:comment-edit').appUser, true);
    assert.deepEqual(getGhAction('release:list').permissions, { contents: 'read' });
    assert.deepEqual(getGhAction('release:view').permissions, { contents: 'read' });
    assert.deepEqual(getGhAction('workflow:list').permissions, { actions: 'read' });
    assert.deepEqual(getGhAction('workflow:view').permissions, { actions: 'read', contents: 'read' });
    assert.deepEqual(getGhAction('label:list').permissions, { issues: 'read' });
    assert.deepEqual(getGhAction('label:create').permissions, { issues: 'write' });
    assert.deepEqual(getGhAction('label:edit').permissions, { issues: 'write' });
    assert.deepEqual(getGhAction('label:delete').permissions, { issues: 'write' });
    assert.equal(getGhAction('pr:checks').timeoutSeconds, 300);
  });

  it('declares the run watch policy', () => {
    assert.deepEqual(getGhAction('run:watch').permissions, {
      actions: 'read',
      checks: 'read',
    });
    assert.equal(getGhAction('run:watch').timeoutSeconds, 3300);
    assert.equal(getGhAction('run:watch').appUser, true);
  });

  it('marks only read paths as readOnly', () => {
    for (const name of [
      'pr:view',
      'pr:list',
      'pr:diff',
      'pr:checks',
      'pr:status',
      'pr:review-by-id',
      'issue:view',
      'issue:list',
      'run:view',
      'run:list',
      'run:watch',
      'release:list',
      'release:view',
      'workflow:list',
      'workflow:view',
      'label:list',
    ]) {
      assert.equal(getGhAction(name).readOnly, true, name);
      assert.equal(getGhAction(name).appUser, true, name);
    }
    for (const name of ['pr:create', 'pr:edit', 'pr:close', 'issue:create', 'run:cancel']) {
      assert.equal(getGhAction(name).readOnly, undefined, name);
    }
    for (const name of Object.keys(GH_ACTIONS)) {
      if (getGhAction(name).readOnly === true) {
        assert.ok(
          !Object.values(getGhAction(name).permissions).includes('write'),
          `${name} is readOnly but declares a write permission`,
        );
      }
    }
  });

  it('declares the lifecycle write policy', () => {
    for (const name of ['run:cancel', 'run:rerun']) {
      assert.equal(getGhAction(name).appUser, true, name);
    }
    assert.equal(getGhAction('pr:ready').appUser, undefined);
    assert.equal(getGhAction('pr:lock').appUser, undefined);
    assert.equal(getGhAction('pr:unlock').appUser, undefined);
    assert.equal(getGhAction('pr:update-branch').appUser, true);
    assert.deepEqual(getGhAction('pr:ready').permissions, { pull_requests: 'write' });
    assert.deepEqual(getGhAction('pr:lock').permissions, { pull_requests: 'write' });
    assert.deepEqual(getGhAction('pr:unlock').permissions, { pull_requests: 'write' });
    assert.deepEqual(getGhAction('pr:update-branch').permissions, {
      pull_requests: 'write',
      contents: 'write',
    });
    assert.deepEqual(getGhAction('run:cancel').permissions, { actions: 'write' });
    assert.deepEqual(getGhAction('run:rerun').permissions, { actions: 'write' });
    for (const [name, seconds] of [
      ['pr:ready', 60],
      ['pr:lock', 60],
      ['pr:unlock', 60],
      ['pr:update-branch', 120],
      ['run:cancel', 60],
      ['run:rerun', 120],
    ] as const) {
      assert.equal(getGhAction(name).timeoutSeconds, seconds, name);
    }
    assert.equal(getGhAction('run:rerun').positionals[0]?.required, undefined);
  });

  it('declares the issue-admin policy', () => {
    for (const name of ['issue:lock', 'issue:unlock', 'issue:pin', 'issue:unpin']) {
      assert.equal(getGhAction(name).appUser, true, name);
      assert.deepEqual(getGhAction(name).permissions, { issues: 'write' }, name);
      assert.equal(getGhAction(name).timeoutSeconds, 60, name);
    }
    assert.equal(getGhAction('issue:pin').target, 'issue');
    assert.equal(getGhAction('issue:unpin').target, 'issue');
  });
});

describe('buildGhArgv', () => {
  it('builds release and workflow read argv', () => {
    assert.deepEqual(buildGhArgv('release:list', { limit: 5, json: 'tagName' }, 'acme/widget'), [
      'release',
      'list',
      '--json',
      'tagName',
      '--limit',
      '5',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('workflow:view', { workflow: 'ci.yml', yaml: true }, 'acme/widget'), [
      'workflow',
      'view',
      '--yaml',
      '--repo',
      'acme/widget',
      '--',
      'ci.yml',
    ]);
    assert.deepEqual(
      buildGhArgv('workflow:view', { workflow: 'ci.yml', ref: 'main', yaml: true }, 'acme/widget'),
      ['workflow', 'view', '--ref', 'main', '--yaml', '--repo', 'acme/widget', '--', 'ci.yml'],
    );
    assert.deepEqual(buildGhArgv('label:create', { name: 'bug', color: 'ff0000' }, 'acme/widget'), [
      'label',
      'create',
      '--color',
      'ff0000',
      '--repo',
      'acme/widget',
      '--',
      'bug',
    ]);
    assert.deepEqual(
      buildGhArgv('label:edit', { label: 'bug', name: 'defect' }, 'acme/widget'),
      ['label', 'edit', '--name', 'defect', '--repo', 'acme/widget', '--', 'bug'],
    );
    assert.deepEqual(
      buildGhArgv('label:delete', { name: 'bug', yes: true }, 'acme/widget'),
      ['label', 'delete', '--yes', '--repo', 'acme/widget', '--', 'bug'],
    );
    assert.throws(() => buildGhArgv('label:delete', { name: 'bug' }, 'acme/widget'), /needs --yes/u);
    assert.throws(
      () => buildGhArgv('label:delete', { name: 'bug', yes: false }, 'acme/widget'),
      /needs --yes/u,
    );

    assert.deepEqual(
      buildGhArgv('issue:comment-delete', { commentId: 123 }, 'acme/widget'),
      ['api', '--method', 'DELETE', 'repos/acme/widget/issues/comments/123'],
    );
    assert.deepEqual(
      buildGhArgv('issue:comment-edit', { commentId: 123, body: 'secret' }, 'acme/widget', '/tmp/body.json'),
      ['api', '--method', 'PATCH', 'repos/acme/widget/issues/comments/123', '--input', '/tmp/body.json'],
    );

    assert.deepEqual(buildGhArgv('workflow:list', { all: true, limit: 10 }, 'acme/widget'), [
      'workflow',
      'list',
      '--all',
      '--limit',
      '10',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('release:view', { tag: 'v1.0.0', json: 'tagName' }, 'acme/widget'), [
      'release',
      'view',
      '--json',
      'tagName',
      '--repo',
      'acme/widget',
      '--',
      'v1.0.0',
    ]);
    const injected = buildGhArgv('release:view', { tag: '--web' }, 'acme/widget');
    assert.deepEqual(injected.slice(-2), ['--', '--web']);
    assert.throws(() => buildGhArgv('workflow:view', {}, 'acme/widget'), /needs workflow/u);
    assert.throws(
      () => buildGhArgv('workflow:view', { workflow: 'ci.yml', ref: 'main' }, 'acme/widget'),
      /needs --yaml with --ref/u,
    );
  });

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

  it('builds a fixed api request without injecting the repository', () => {
    assert.deepEqual(
      buildGhArgv('pr:review-by-id', { number: 42, id: 9, jq: '.body' }, 'acme/widget'),
      ['api', '--method', 'GET', 'repos/acme/widget/pulls/42/reviews/9', '--jq', '.body'],
    );
    assert.throws(
      () => buildGhArgv('pr:review-by-id', { number: 42, id: 0 }, 'acme/widget'),
      /id/,
    );
    assert.throws(
      () => buildGhArgv('pr:review-by-id', { number: 42, id: 9007199254740993 }, 'acme/widget'),
      /positive integer/,
    );
  });

  it('builds the edit flags', () => {
    assert.deepEqual(
      buildGhArgv('pr:edit', { number: 7, title: 't', base: 'main' }, 'acme/widget'),
      ['pr', 'edit', '7', '--title', 't', '--base', 'main', '--repo', 'acme/widget'],
    );
  });

  it('builds the issue-admin argv', () => {
    assert.deepEqual(buildGhArgv('issue:lock', { number: 7 }, 'acme/widget'), [
      'issue',
      'lock',
      '7',
      '--repo',
      'acme/widget',
    ]);
    assert.throws(
      () => buildGhArgv('issue:lock', {}, 'acme/widget'),
      /needs number/u,
    );
    assert.deepEqual(buildGhArgv('issue:lock', { number: 7, reason: 'spam' }, 'acme/widget'), [
      'issue',
      'lock',
      '7',
      '--reason',
      'spam',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('issue:unlock', { number: 7 }, 'acme/widget'), [
      'issue',
      'unlock',
      '7',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('issue:pin', { number: 7 }, 'acme/widget'), [
      'issue',
      'pin',
      '7',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('issue:unpin', { number: 7 }, 'acme/widget'), [
      'issue',
      'unpin',
      '7',
      '--repo',
      'acme/widget',
    ]);
  });

  it('builds the lifecycle argv', () => {
    assert.deepEqual(buildGhArgv('pr:ready', { number: 7, undo: true }, 'acme/widget'), [
      'pr',
      'ready',
      '7',
      '--undo',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('pr:lock', { number: 7, reason: 'spam' }, 'acme/widget'), [
      'pr',
      'lock',
      '7',
      '--reason',
      'spam',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('pr:unlock', { number: 7 }, 'acme/widget'), [
      'pr',
      'unlock',
      '7',
      '--repo',
      'acme/widget',
    ]);
    assert.throws(() => buildGhArgv('pr:lock', {}, 'acme/widget'), /needs number/u);
    assert.throws(() => buildGhArgv('pr:unlock', {}, 'acme/widget'), /needs number/u);
    assert.deepEqual(buildGhArgv('pr:update-branch', { number: 7, rebase: true }, 'acme/widget'), [
      'pr',
      'update-branch',
      '7',
      '--rebase',
      '--repo',
      'acme/widget',
    ]);
    assert.throws(() => buildGhArgv('pr:update-branch', {}, 'acme/widget'), /needs number/u);
    assert.deepEqual(buildGhArgv('run:watch', { runId: 42, compact: true, 'exit-status': true }, 'acme/widget'), [
      'run',
      'watch',
      '42',
      '--compact',
      '--exit-status',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('run:cancel', { runId: 42, force: true }, 'acme/widget'), [
      'run',
      'cancel',
      '42',
      '--force',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('run:rerun', { runId: 42, failed: true }, 'acme/widget'), [
      'run',
      'rerun',
      '42',
      '--failed',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('run:rerun', { job: '99' }, 'acme/widget'), [
      'run',
      'rerun',
      '--job',
      '99',
      '--repo',
      'acme/widget',
    ]);
    assert.throws(
      () => buildGhArgv('run:rerun', { job: '' }, 'acme/widget'),
      /non-empty/u,
    );
    assert.throws(
      () => buildGhArgv('run:rerun', { runId: 42, job: '99' }, 'acme/widget'),
      /exactly one of runId, --job/u,
    );
    assert.throws(
      () => buildGhArgv('run:rerun', {}, 'acme/widget'),
      /exactly one of runId, --job/u,
    );
    assert.throws(
      () => buildGhArgv('run:rerun', { runId: 42, failed: true, job: '99' }, 'acme/widget'),
      /exactly one of runId, --job/u,
    );
    assert.throws(
      () => buildGhArgv('run:rerun', { failed: true, job: '99' }, 'acme/widget'),
      /does not allow --failed with --job/u,
    );
  });

  it('builds the read action argv', () => {
    assert.deepEqual(buildGhArgv('issue:view', { number: 7, comments: true }, 'acme/widget'), [
      'issue',
      'view',
      '7',
      '--comments',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(
      buildGhArgv('issue:list', { state: 'closed', label: ['bug', 'p1'], limit: 5 }, 'acme/widget'),
      [
        'issue',
        'list',
        '--label',
        'bug',
        '--label',
        'p1',
        '--limit',
        '5',
        '--state',
        'closed',
        '--repo',
        'acme/widget',
      ],
    );
    assert.deepEqual(buildGhArgv('pr:checks', { number: 7, required: true }, 'acme/widget'), [
      'pr',
      'checks',
      '7',
      '--required',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('pr:status', {}, 'acme/widget'), [
      'pr',
      'status',
      '--repo',
      'acme/widget',
    ]);
  });

  it('builds the reopen and issue close argv', () => {
    assert.deepEqual(buildGhArgv('pr:reopen', { number: 7 }, 'acme/widget'), [
      'pr',
      'reopen',
      '7',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('issue:close', { number: 7, reason: 'duplicate' }, 'acme/widget'), [
      'issue',
      'close',
      '7',
      '--reason',
      'duplicate',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('issue:reopen', { number: 7 }, 'acme/widget'), [
      'issue',
      'reopen',
      '7',
      '--repo',
      'acme/widget',
    ]);
  });

  it('builds issue edit and comment argv', () => {
    assert.deepEqual(buildGhArgv('issue:edit', { number: 7, title: 't' }, 'acme/widget'), [
      'issue',
      'edit',
      '7',
      '--title',
      't',
      '--repo',
      'acme/widget',
    ]);
    assert.deepEqual(buildGhArgv('issue:comment', { number: 7, body: 'note' }, 'acme/widget'), [
      'issue',
      'comment',
      '7',
      '--body',
      'note',
      '--repo',
      'acme/widget',
    ]);
  });

  it('requires at least one edit field', () => {
    assert.throws(() => buildGhArgv('issue:edit', { number: 7 }, 'acme/widget'), /at least one of --title, --body/u);
    assert.throws(
      () => buildGhArgv('pr:edit', { number: 7 }, 'acme/widget'),
      /at least one of --title, --body, --base/u,
    );
  });

  it('rejects an empty comment body in the catalog', () => {
    assert.throws(
      () => buildGhArgv('issue:comment', { number: 7, body: '   ' }, 'acme/widget'),
      /issue:comment needs a non-empty --body/u,
    );
  });

  it('validates a body before substituting the body file', () => {
    assert.throws(
      () => buildGhArgv('issue:comment', { number: 7, body: false }, 'acme/widget', '/tmp/body'),
      /body must be a string/u,
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
