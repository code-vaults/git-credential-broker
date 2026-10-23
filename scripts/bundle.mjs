/**
 * Bundle the two entry points into self-contained ESM files.
 *
 * The broker runs from a staged commit with no `node_modules`, so every runtime dependency has to
 * be inside the bundle. `esbuild` itself is a build-time tool: in a normal build it comes from the
 * checkout's `node_modules`; when `stage` builds an exported commit it passes that path explicitly,
 * because the staged tree has no install step.
 *
 * Usage:
 *   node scripts/bundle.mjs [--root <dir>] [--node-modules <dir>]
 *
 * `--root` defaults to the repository containing this script. `--node-modules` defaults to
 * `<root>/node_modules`; `stage` points it at the source checkout so the exported commit can be
 * bundled without installing anything beside it.
 */
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Parse the two path flags this build needs. */
function options(argv) {
  const values = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), nodeModules: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      values.root = path.resolve(argv[++index]);
    } else if (argument === '--node-modules') {
      values.nodeModules = path.resolve(argv[++index]);
    } else {
      throw new Error(`unknown bundle option: ${argument}`);
    }
  }
  values.nodeModules ??= path.join(values.root, 'node_modules');
  return values;
}

/**
 * Load esbuild from the checkout that owns the build tool, not from the tree being bundled.
 *
 * @param nodeModules - a directory containing `esbuild`.
 * @returns the esbuild module.
 */
function loadEsbuild(nodeModules) {
  const require = createRequire(path.join(nodeModules, 'noop.cjs'));
  return require('esbuild');
}

const { root, nodeModules } = options(process.argv.slice(2));
const esbuild = loadEsbuild(nodeModules);

mkdirSync(path.join(root, 'dist'), { recursive: true });

for (const [entry, output] of [
  ['src/cli/helper.ts', 'dist/gcb.js'],
  ['src/cli/daemon.ts', 'dist/gcb-daemon.js'],
]) {
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
