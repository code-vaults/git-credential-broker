/**
 * Bundle the two entry points into self-contained ESM files.
 *
 * This runs inside the tree being built: a normal `yarn bundle` from the checkout, or `stage` after
 * it has installed that commit's dependencies in the staged directory. Everything resolves from
 * this script's own repository, so there is no second root to pass around.
 *
 * `stage` removes `node_modules` after the build; the deployment runs only the bundles.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
