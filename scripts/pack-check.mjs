/**
 * Show exactly what each publishable workspace would ship.
 *
 * This is a dry run: it does not install anything. The real install path is exercised by
 * test/e2e/packages.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'gcb-pack-check-'));
try {
  for (const name of ['cli', 'client', 'host']) {
    console.log(`\n== packages/${name}`);
    execFileSync('npm', ['pack', path.join(root, 'packages', name), '--dry-run', '--pack-destination', scratch], {
      cwd: root,
      stdio: 'inherit',
    });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
