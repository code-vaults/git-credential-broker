#!/usr/bin/env node
/**
 * Generate the README's action permission table from the catalog.
 *
 * Run with no arguments to rewrite the marked block; run with --check to fail when it is stale.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GH_ACTIONS } from '../packages/core/src/actions.ts'

const README = fileURLToPath(new URL('../README.md', import.meta.url))
const START = '<!-- action-permissions:start -->'
const END = '<!-- action-permissions:end -->'

/** The label README uses for one action. */
function label(name, action) {
  return name === 'pr:review-by-id' ? 'pr review --id' : action.command.join(' ')
}

/** The catalog-id suffix for the one action whose label differs from it. */
function annotation(name) {
  return name === 'pr:review-by-id' ? ' (`pr:review-by-id`)' : ''
}

/** Render the table rows from the catalog. */
function render() {
  const lines = ['| Action | App permissions |', '|---|---|']
  for (const [name, action] of Object.entries(GH_ACTIONS)) {
    const permissions = Object.entries(action.permissions)
      .map(([permission, level]) => `\`${permission}: ${level}\``)
      .join(', ')
    lines.push(`| \`${label(name, action)}\`${annotation(name)} | ${permissions} |`)
  }
  return lines.join('\n')
}

/** Format the table with oxfmt; the script does not own alignment. */
function formatTable(block) {
  const directory = mkdtempSync(join(tmpdir(), 'gcb-actions-'));
  const file = join(directory, 'table.md');
  try {
    writeFileSync(file, `${block}\n`);
    execFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules/.bin/oxfmt'), [file], {
      stdio: 'ignore',
    });
    return readFileSync(file, 'utf8').trimEnd();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const readme = readFileSync(README, 'utf8')
const start = readme.indexOf(START)
const end = readme.indexOf(END)
if (start < 0 || end < start) {
  throw new Error(`README is missing ${START} ... ${END}`)
}
const eol = readme.includes('\r\n') ? '\r\n' : '\n'
const expected = `${START}${eol}${formatTable(render()).replaceAll('\n', eol)}${eol}${END}`
const actual = readme.slice(start, end + END.length)
if (process.argv.includes('--check')) {
  if (actual !== expected) {
    throw new Error('README action permission table is stale; run `yarn docs:actions`')
  }
} else {
  const temporary = `${README}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, readme.slice(0, start) + expected + readme.slice(end + END.length))
    renameSync(temporary, README)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file was never created; the original README is untouched.
    }
    throw error
  }
}
