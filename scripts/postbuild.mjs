/**
 * Post-build fixups for the two top-level bins.
 *
 * tsc compiles the libraries; the bins are plain JavaScript checked in with their shebang. npm
 * links them, but a checkout run needs the executable bit too.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const SHEBANG = '#!/usr/bin/env node';
const ENTRY_POINTS = ['packages/client/bin/gcb.js', 'packages/host/bin/gcb.js'];

let failed = false;
for (const file of ENTRY_POINTS) {
  if (!existsSync(file)) {
    console.error(`postbuild: missing bin ${file}`);
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
