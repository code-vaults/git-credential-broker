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

/**
 * Resolve the configured primary.
 *
 * Only `gh` is implemented; an unknown name fails closed instead of falling back to a different
 * CLI that would interpret the argv differently.
 *
 * @param env - the environment to read `GCB_PRIMARY` from.
 * @returns the selected primary.
 */
export function primaryFromEnv(env: NodeJS.ProcessEnv = process.env): Primary {
  const configured = env['GCB_PRIMARY'] ?? 'gh';
  if (configured !== GH_PRIMARY.name) {
    fail(`unsupported primary ${JSON.stringify(configured)}; only gh is implemented`);
  }
  return GH_PRIMARY;
}
