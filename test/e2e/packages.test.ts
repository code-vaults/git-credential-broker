/**
 * The real distribution path: pack the three workspaces and install the two top-level packages
 * into separate temporary prefixes, exactly as a container and a host would.
 *
 * This is deliberately not an import test. It catches a missing `files` entry, a bin that points
 * nowhere, a dependency that was left in the wrong package, and the role-mismatch message.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gcb-packages-'));
const packs = path.join(scratch, 'packs');
const clientPrefix = path.join(scratch, 'client');
const hostPrefix = path.join(scratch, 'host');

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** Run a command and return stdout. */
function run(command: string, args: readonly string[]): string {
  return execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Run a command that is expected to fail, returning its stderr. */
function runFailure(command: string, args: readonly string[]): string {
  try {
    execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? '');
  }
  assert.fail(`${command} ${args.join(' ')} unexpectedly succeeded`);
}

/** Pack one workspace. */
function pack(name: string): string {
  const target = path.join(packs, name);
  fs.mkdirSync(target, { recursive: true });
  const manifestPath = path.join(ROOT, 'packages', name, 'package.json');
  const manifest = fs.readFileSync(manifestPath, 'utf8');
  try {
    const output = run('npm', ['pack', path.join(ROOT, 'packages', name), '--pack-destination', target]);
    const file = output.trim().split('\n').pop();
    assert.ok(file, `npm pack produced no filename for ${name}`);
    return path.join(target, file);
  } finally {
    // prepack runs clean-pkg-json in the workspace; restore the source manifest.
    fs.writeFileSync(manifestPath, manifest);
  }
}

/** Find a package below a prefix. */
function hasPackage(prefix: string, name: string): boolean {
  const pending = [path.join(prefix, 'node_modules'), path.join(prefix, 'lib', 'node_modules')];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir || !fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === name && fs.existsSync(path.join(full, 'package.json'))) return true;
        pending.push(full);
      }
    }
  }
  return false;
}

/** The installed bin. */
function bin(prefix: string): string {
  return path.join(prefix, 'bin', 'gcb');
}

describe('packed npm packages', () => {
  before(() => {
    fs.mkdirSync(packs, { recursive: true });
    const core = pack('core');
    const client = pack('client');
    const host = pack('host');

    run('npm', ['install', '-g', '--prefix', clientPrefix, '--no-audit', '--no-fund', core, client]);
    run('npm', ['install', '-g', '--prefix', hostPrefix, '--no-audit', '--no-fund', core, host]);
  });

  it('installs a working client without the host parser', () => {
    assert.match(run(bin(clientPrefix), ['--help']), /gcb-client/);
    assert.equal(hasPackage(clientPrefix, 'yaml'), false, 'gcb-client must not install yaml');
    assert.match(runFailure(bin(clientPrefix), ['app']), /host command; install gcb-host/);
  });

  it('installs a working host with yaml', () => {
    assert.match(run(bin(hostPrefix), ['--help']), /gcb-host/);
    assert.equal(hasPackage(hostPrefix, 'yaml'), true, 'gcb-host must install yaml');
    assert.match(runFailure(bin(hostPrefix), ['setup']), /client command; install gcb-client/);
    assert.match(run(bin(hostPrefix), ['app', '--help']), /broker/);
    assert.match(run(bin(hostPrefix), ['host', '--help']), /host-opener|Watch/i);
  });
});
