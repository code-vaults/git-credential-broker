/**
 * The package version, imported as JSON.
 */
import pkg from '../package.json' with { type: 'json' };

/** The version of the running package. */
export const PACKAGE_VERSION: string = pkg.version;
