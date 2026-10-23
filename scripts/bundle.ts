/**
 * Bundle the two entry points into self-contained ESM files.
 *
 * The broker runs from a staged commit with no install step, so every runtime dependency has to
 * be inside the bundle. `esbuild` is a build-time tool from this checkout's `node_modules`;
 * `stage` makes that directory visible to the staged build with a temporary `node_modules`
 * symlink, so this script can import esbuild normally and still bundle the exported source.
 *
 * Usage:
 *   node scripts/bundle.ts [--root <dir>]
 *
 * `--root` defaults to the repository containing this script. `nodePaths` points at that root's
 * `node_modules`, which is where `stage` puts the symlink and where a normal build finds it.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let root = scriptRoot;
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--root') {
    root = path.resolve(argv[++index] ?? '.');
  } else {
    throw new Error(`unknown bundle option: ${String(argv[index])}`);
  }
}

const nodeModules = path.join(root, 'node_modules');
mkdirSync(path.join(root, 'dist'), { recursive: true });

for (const [entry, output] of [
  ['src/cli/helper.ts', 'dist/gcb.js'],
  ['src/cli/daemon.ts', 'dist/gcb-daemon.js'],
] as const) {
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: path.join(root, output),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    sourcemap: true,
    nodePaths: [nodeModules],
    logLevel: 'warning',
  });
  chmodSync(path.join(root, output), 0o755);
  console.log(`bundle: ${output}`);
}
