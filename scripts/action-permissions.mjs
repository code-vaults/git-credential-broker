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

/** Format the whole next README with oxfmt; the script owns no layout. */
function formatReadme(content) {
  const directory = mkdtempSync(join(tmpdir(), 'gcb-actions-'))
  const file = join(directory, 'README.md')
  try {
    writeFileSync(file, content)
    execFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules/.bin/oxfmt'), [file], {
      stdio: 'ignore',
    })
    return readFileSync(file, 'utf8')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const readme = readFileSync(README, 'utf8')
const start = readme.indexOf(START)
const end = readme.indexOf(END)
if (start < 0 || end < start) {
  throw new Error(`README is missing ${START} ... ${END}`)
}
const eol = readme.includes('\r\n') ? '\r\n' : '\n'
const block = `${START}${eol}${render().replaceAll('\n', eol)}${eol}${END}`
const next = formatReadme(readme.slice(0, start) + block + readme.slice(end + END.length))
if (process.argv.includes('--check')) {
  if (next !== readme) {
    throw new Error('README action permission table is stale; run `yarn docs:actions`')
  }
} else {
  const temporary = `${README}.${process.pid}.tmp`
  try {
    writeFileSync(temporary, next)
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
