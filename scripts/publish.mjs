/** Publish through Changesets, except before the manual 0.0.0 release. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const versions = ['cli', 'client', 'host'].map((name) =>
  JSON.parse(readFileSync(path.join(root, 'packages', name, 'package.json'), 'utf8')).version,
);
if (versions.every((version) => version === '0.0.0')) {
  console.log('The initial 0.0.0 release is manual; skipping changeset publish.');
  process.exit(0);
}
execFileSync('changeset', ['publish'], { cwd: root, stdio: 'inherit' });
