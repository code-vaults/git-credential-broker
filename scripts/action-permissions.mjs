#!/usr/bin/env node
/**
 * Generate the README's action permission table from the catalog.
 *
 * Run with no arguments to rewrite the marked block; run with --check to fail when it is stale.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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
  const rows = Object.entries(GH_ACTIONS).map(([name, action]) => {
    const permissions = Object.entries(action.permissions)
      .map(([permission, level]) => `\`${permission}: ${level}\``)
      .join(', ')
    return [`\`${label(name, action)}\`${annotation(name)}`, permissions]
  })
  const actionWidth = Math.max('Action'.length, ...rows.map(([action]) => action.length))
  const permissionWidth = Math.max(
    'App permissions'.length,
    ...rows.map(([, permissions]) => permissions.length),
  )
  const pad = (value, width) => value + ' '.repeat(width - value.length)
  const lines = [
    `| ${pad('Action', actionWidth)} | ${pad('App permissions', permissionWidth)} |`,
    `| ${'-'.repeat(actionWidth)} | ${'-'.repeat(permissionWidth)} |`,
    ...rows.map(
      ([action, permissions]) =>
        `| ${pad(action, actionWidth)} | ${pad(permissions, permissionWidth)} |`,
    ),
  ]
  return lines.join('\n')
}

const readme = readFileSync(README, 'utf8')
const start = readme.indexOf(START)
const end = readme.indexOf(END)
if (start < 0 || end < start) {
  throw new Error(`README is missing ${START} ... ${END}`)
}
const eol = readme.includes('\r\n') ? '\r\n' : '\n'
const expected = `${START}${eol}${render().replaceAll('\n', eol)}${eol}${END}`
const actual = readme.slice(start, end + END.length)
if (process.argv.includes('--check')) {
  if (actual.replaceAll('\r\n', '\n') !== expected.replaceAll('\r\n', '\n')) {
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
