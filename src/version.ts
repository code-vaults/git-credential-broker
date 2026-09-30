/**
 * Read the package version from package.json.
 *
 * Resolved relative to this module so it works both from `src/` (run directly by Node's type
 * stripping) and from `dist/`.
 */
import { readFileSync } from 'node:fs';

/**
 * The version of the running package.
 *
 * @returns the `version` field, or `0.0.0` when it cannot be read.
 */
export function packageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
