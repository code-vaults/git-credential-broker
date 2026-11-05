/**
 * The README permission table is user-facing documentation; the catalog is the source. Keep the
 * two from drifting without generating the README at build time.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { GH_ACTIONS } from '../../packages/core/src/actions.ts';

const README = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

describe('README action permissions', () => {
  it('lists every catalog action with its declared permissions', () => {
    for (const [name, action] of Object.entries(GH_ACTIONS)) {
      const label = name === 'pr:review-by-id' ? 'pr review --id' : action.command.join(' ');
      const row = README.split('\n').find((line) => line.startsWith(`| \`${label}\``));
      assert.ok(row, `${name} is missing from the README table`);
      const documented = [...row.matchAll(/`([a-z_]+): (read|write)`/gu)].map(
        (match) => `${match[1]}: ${match[2]}`,
      );
      const declared = Object.entries(action.permissions).map(
        ([permission, level]) => `${permission}: ${level}`,
      );
      assert.deepEqual(
        documented.sort(),
        declared.sort(),
        `${name} documents a different permission set than the catalog`,
      );
    }
  });
});
