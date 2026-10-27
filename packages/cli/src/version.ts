/**
 * The package version, imported as JSON.
 */
import pkg from '../package.json' with { type: 'json' };

/**
 * The version of the running package.
 *
 * @returns the `version` field.
 */
export function packageVersion(): string {
  return pkg.version;
}
