/**
 * The CLI adapter that runs a catalogued action.
 *
 * The action catalog names `gh` commands today. A primary is the small seam between dispatch and
 * that CLI, so selecting another forge CLI later does not require editing every command module.
 */
import { fail } from 'gcb-core';

import { runGh } from './commands/gh.ts';

/** Options a primary passes through to the action runner. */
export interface PrimaryRunOptions {
  readonly unreachableExitCode?: number;
  readonly identity?: 'app' | 'user';
}

/** One CLI that can run a catalogued action. */
export interface Primary {
  /** The configured name, e.g. `gh`. */
  readonly name: string;
  /** Run one catalogued action. */
  run(argv: readonly string[], options?: PrimaryRunOptions): Promise<number>;
}

/** The `gh` adapter. */
export const GH_PRIMARY: Primary = {
  name: 'gh',
  run: (argv, options) => runGh(argv, options),
};

/** The adapters available in production. */
const DEFAULT_PRIMARIES: Readonly<Record<string, Primary>> = { [GH_PRIMARY.name]: GH_PRIMARY };

/**
 * Resolve the configured primary.
 *
 * Only `gh` is implemented; an unknown name fails closed instead of falling back to a different
 * CLI that would interpret the argv differently.
 *
 * @param env - the environment to read `GCB_PRIMARY` from.
 * @param primaries - the available adapters, keyed by name.
 * @returns the selected primary.
 */

export function primaryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  primaries: Readonly<Record<string, Primary>> = DEFAULT_PRIMARIES,
): Primary {
  const configured = env['GCB_PRIMARY'] ?? GH_PRIMARY.name;
  const selected = Object.hasOwn(primaries, configured) ? primaries[configured] : undefined;
  if (selected === undefined) {
    const available = Object.keys(primaries).join(', ');
    fail(`unsupported primary ${JSON.stringify(configured)}; available: ${available}`);
  }
  return selected;
}
