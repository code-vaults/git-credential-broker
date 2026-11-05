#!/usr/bin/env node
/**
 * Generate the README's action permission table from the catalog.
 *
 * Run with no arguments to rewrite the marked block; run with --check to fail when it is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { GH_ACTIONS } from '../packages/core/src/actions.ts';

const README = fileURLToPath(new URL('../README.md', import.meta.url));
const START = '<!-- action-permissions:start -->';
const END = '<!-- action-permissions:end -->';

const label = (name, action) =>
  name === 'pr:review-by-id' ? 'pr review --id' : action.command.join(' ');

function render() {
  const lines = ['| Action | App permissions |', '|---|---|'];
  for (const [name, action] of Object.entries(GH_ACTIONS)) {
    const permissions = Object.entries(action.permissions)
      .map(([permission, level]) => `\`${permission}: ${level}\``)
      .join(', ');
    lines.push(`| \`${label(name, action)}\` | ${permissions} |`);
  }
  return lines.join('\n');
}

const readme = readFileSync(README, 'utf8');
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start < 0 || end < start) {
  throw new Error(`README is missing ${START} ... ${END}`);
}
const expected = `${START}\n${render()}\n${END}`;
const actual = readme.slice(start, end + END.length);
if (process.argv.includes('--check')) {
  if (actual !== expected) {
    throw new Error('README action permission table is stale; run `yarn docs:actions`');
  }
} else {
  writeFileSync(README, readme.slice(0, start) + expected + readme.slice(end + END.length));
}
