/**
 * Canonical paths, for the checks that compare one place against another.
 *
 * A directory can have more than one name — a symlinked `$HOME`, a mount the host spells one way and
 * the container another — and a lexical prefix comparison calls those different places. The checks
 * that keep the broker's code out of a container mount, and the opener inside the roots it serves,
 * have to compare real paths rather than spellings.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * A path with the symlinks in its existing part resolved.
 *
 * `realpathSync` throws for a path that does not exist yet, and `stage` is asked to write to one, so the
 * nearest existing ancestor is resolved and the rest is appended. Comparing raw spellings is what lets
 * one directory with two names — a symlinked home, a bind mount reached two ways — look like two
 * different places, which is exactly the bypass these checks exist to close.
 *
 * @param target - the path to canonicalize.
 * @returns the real path, or the resolved path when nothing on it exists.
 * @throws {Error} when the path cannot be resolved for a reason other than being absent, because a
 *   lexical answer there could call a path inside a mount outside it.
 */
export function canonicalPath(target: string): string {
  const absolute = path.resolve(target);
  let existing = absolute;
  const missing: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(existing);
      return missing.length === 0 ? real : path.join(real, ...missing.toReversed());
    } catch (error) {
      // Only a path that is not there is walked up. Anything else — EACCES, ELOOP — means the real path
      // cannot be known, and a lexical fallback could miss a symlinked component and pass a path the
      // check exists to refuse, so it propagates and the caller fails closed.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(existing);
      // Unreachable while the root exists and realpaths; kept so a filesystem that refuses even `/`
      // cannot spin here forever.
      if (parent === existing) return absolute;
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
}
