/** Remove generated output before a build, so a deleted source cannot survive in lib. */
import { rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
for (const name of ['core', 'client', 'host']) {
  rmSync(path.join(root, 'packages', name, 'lib'), { recursive: true, force: true });
}
