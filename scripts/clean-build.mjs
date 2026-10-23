/** Remove generated output before a build, so a deleted source cannot survive in dist. */
import { rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
for (const name of ['cli', 'client', 'host']) {
  rmSync(path.join(root, 'packages', name, 'dist'), { recursive: true, force: true });
}
