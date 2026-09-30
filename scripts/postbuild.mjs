/**
 * Post-build fixups for the compiled CLI entry points.
 *
 * Two things `tsc` alone does not guarantee, and both matter because git execs these
 * files directly rather than through a shell:
 *   - the `#!` line must survive compilation, otherwise the file is not executable;
 *   - the executable bit must be set.
 *
 * This script is plain JavaScript on purpose: it runs before/independently of any
 * TypeScript compilation, so it cannot itself need compiling.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const SHEBANG = '#!/usr/bin/env node';
const ENTRY_POINTS = ['dist/cli/helper.js', 'dist/cli/daemon.js'];

let failed = false;
for (const file of ENTRY_POINTS) {
  if (!existsSync(file)) {
    console.error(`postbuild: missing build output ${file}`);
    failed = true;
    continue;
  }
  const source = readFileSync(file, 'utf8');
  const text = source.startsWith('#!') ? source : `${SHEBANG}\n${source}`;
  writeFileSync(file, text);
  chmodSync(file, 0o755);
  console.log(`postbuild: ${file} is executable`);
}
if (failed) process.exitCode = 1;
