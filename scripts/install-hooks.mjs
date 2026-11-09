#!/usr/bin/env node
/**
 * Install the opt-in git hooks into this checkout.
 *
 * The hooks are tracked in .githooks, not installed silently by yarn install.
 * Run `yarn hooks:install` once per checkout; `GCB_SKIP_TYPECHECK=1 git push`
 * bypasses the pre-push check for WIP commits.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' }).trim();
const hooksDir = join(resolve(root, gitDir), 'hooks');
mkdirSync(hooksDir, { recursive: true });
const source = join(root, '.githooks', 'pre-push');
const target = join(hooksDir, 'pre-push');
copyFileSync(source, target);
chmodSync(target, 0o755);
console.log(`installed ${target}`);
