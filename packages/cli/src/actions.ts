/**
 * The one table that describes an allowed `gh` action.
 *
 * The broker never forwards a caller's argv. It looks an action up here, validates the values, and
 * rebuilds a canonical argv. Everything that needs to agree about an action — the command table, the
 * token permissions, the creation preflight and the docs — reads this table.
 *
 * The table is intentionally small and curated: `gh` exposes no machine-readable command-to-permission
 * mapping. Adding an action requires the GitHub endpoint documentation for its command and a test.
 */

/** The installation permissions these actions may need. */
export type GhPermission =
  | 'actions'
  | 'checks'
  | 'contents'
  | 'issues'
  | 'pull_requests'
  | 'statuses';

/** The level requested for one permission. */
export type PermissionLevel = 'read' | 'write';

/** A positional argument an action requires or accepts. */
export interface PositionalSpec {
  readonly name: string;
  readonly type: 'number' | 'string';
  readonly required?: boolean;
}

/** A long flag an action accepts. */
export interface FlagSpec {
  readonly name: string;
  readonly type: 'boolean' | 'number' | 'string';
  /** The flag may be repeated, and the value is a list. */
  readonly repeatable?: boolean;
  /** The flag must be present. */
  readonly required?: boolean;
}

/** One allowed `gh` action. */
export interface GhAction {
  readonly name: string;
  /** The subcommand after the `gh` binary, e.g. `['pr', 'view']`. */
  readonly command: readonly string[];
  readonly positionals: readonly PositionalSpec[];
  readonly flags: readonly FlagSpec[];
  /** Exactly one of these flags must be present, when set. */
  readonly exactlyOneOf?: readonly string[];
  readonly permissions: Readonly<Partial<Record<GhPermission, PermissionLevel>>>;
  /** The default per-action timeout, in seconds. */
  readonly timeoutSeconds: number;
  /** Whether the host broker may run this as a person with `--as-user`. */
  readonly hostUser: boolean;
}

/** Values supplied by the caller, keyed by positional or flag name. */
export type ActionValues = Readonly<Record<string, string | number | boolean | readonly string[] | undefined>>;

/** A failure the caller can act on, and that contains no provider output. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

// GitHub: GET /repos/{owner}/{repo}/pulls/{pull_number}
const PR_VIEW: GhAction = {
  name: 'pr:view',
  command: ['pr', 'view'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [
    { name: 'json', type: 'string' },
    { name: 'jq', type: 'string' },
    { name: 'comments', type: 'boolean' },
  ],
  permissions: { pull_requests: 'read', contents: 'read', checks: 'read', statuses: 'read' },
  timeoutSeconds: 120,
  hostUser: false,
};

// GitHub: GET /repos/{owner}/{repo}/pulls
const PR_LIST: GhAction = {
  name: 'pr:list',
  command: ['pr', 'list'],
  positionals: [],
  flags: [
    { name: 'state', type: 'string' },
    { name: 'limit', type: 'number' },
    { name: 'json', type: 'string' },
    { name: 'jq', type: 'string' },
    { name: 'head', type: 'string' },
    { name: 'base', type: 'string' },
    { name: 'label', type: 'string', repeatable: true },
    { name: 'author', type: 'string' },
    { name: 'assignee', type: 'string' },
    { name: 'draft', type: 'boolean' },
  ],
  permissions: { pull_requests: 'read' },
  timeoutSeconds: 120,
  hostUser: false,
};

// GitHub: GET /repos/{owner}/{repo}/pulls/{pull_number} (diff media type)
const PR_DIFF: GhAction = {
  name: 'pr:diff',
  command: ['pr', 'diff'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [
    { name: 'name-only', type: 'boolean' },
    { name: 'patch', type: 'boolean' },
    { name: 'color', type: 'string' },
  ],
  permissions: { pull_requests: 'read', contents: 'read' },
  timeoutSeconds: 120,
  hostUser: false,
};

// GitHub: POST /repos/{owner}/{repo}/pulls
const PR_CREATE: GhAction = {
  name: 'pr:create',
  command: ['pr', 'create'],
  positionals: [],
  flags: [
    { name: 'head', type: 'string', required: true },
    { name: 'base', type: 'string' },
    { name: 'title', type: 'string', required: true },
    { name: 'body', type: 'string', required: true },
    { name: 'draft', type: 'boolean' },
    { name: 'label', type: 'string', repeatable: true },
    { name: 'assignee', type: 'string', repeatable: true },
    { name: 'reviewer', type: 'string', repeatable: true },
  ],
  permissions: { pull_requests: 'write', contents: 'read' },
  timeoutSeconds: 180,
  hostUser: true,
};

// GitHub: POST /repos/{owner}/{repo}/issues/{issue_number}/comments
const PR_COMMENT: GhAction = {
  name: 'pr:comment',
  command: ['pr', 'comment'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [{ name: 'body', type: 'string', required: true }],
  permissions: { pull_requests: 'write' },
  timeoutSeconds: 120,
  hostUser: true,
};

// GitHub: POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews
const PR_REVIEW: GhAction = {
  name: 'pr:review',
  command: ['pr', 'review'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [
    { name: 'approve', type: 'boolean' },
    { name: 'request-changes', type: 'boolean' },
    { name: 'comment', type: 'boolean' },
    { name: 'body', type: 'string' },
  ],
  exactlyOneOf: ['approve', 'request-changes', 'comment'],
  permissions: { pull_requests: 'write' },
  timeoutSeconds: 120,
  hostUser: true,
};

// GitHub: POST /repos/{owner}/{repo}/issues
const ISSUE_CREATE: GhAction = {
  name: 'issue:create',
  command: ['issue', 'create'],
  positionals: [],
  flags: [
    { name: 'title', type: 'string', required: true },
    { name: 'body', type: 'string', required: true },
    { name: 'label', type: 'string', repeatable: true },
    { name: 'assignee', type: 'string', repeatable: true },
  ],
  permissions: { issues: 'write' },
  timeoutSeconds: 120,
  hostUser: true,
};

// GitHub: GET /repos/{owner}/{repo}/actions/runs/{run_id}
const RUN_VIEW: GhAction = {
  name: 'run:view',
  command: ['run', 'view'],
  positionals: [{ name: 'runId', type: 'number', required: true }],
  flags: [
    { name: 'log', type: 'boolean' },
    { name: 'job', type: 'string' },
    { name: 'json', type: 'string' },
    { name: 'jq', type: 'string' },
    { name: 'attempt', type: 'number' },
  ],
  permissions: { actions: 'read' },
  timeoutSeconds: 300,
  hostUser: false,
};

// GitHub: GET /repos/{owner}/{repo}/actions/runs
const RUN_LIST: GhAction = {
  name: 'run:list',
  command: ['run', 'list'],
  positionals: [],
  flags: [
    { name: 'limit', type: 'number' },
    { name: 'workflow', type: 'string' },
    { name: 'branch', type: 'string' },
    { name: 'json', type: 'string' },
    { name: 'jq', type: 'string' },
  ],
  permissions: { actions: 'read' },
  timeoutSeconds: 120,
  hostUser: false,
};

/** Every built-in action, keyed by its action name. */
export const GH_ACTIONS: Readonly<Record<string, GhAction>> = Object.freeze({
  'pr:view': PR_VIEW,
  'pr:list': PR_LIST,
  'pr:diff': PR_DIFF,
  'pr:create': PR_CREATE,
  'pr:comment': PR_COMMENT,
  'pr:review': PR_REVIEW,
  'issue:create': ISSUE_CREATE,
  'run:view': RUN_VIEW,
  'run:list': RUN_LIST,
});

/** The built-in action names, in a stable order. */
export const GH_ACTION_NAMES = Object.freeze(Object.keys(GH_ACTIONS));

/**
 * Look up one action.
 *
 * @param name - the action name, e.g. `pr:create`.
 * @returns the action.
 * @throws {ActionError} when the action is not in the catalog.
 */
export function getGhAction(name: string): GhAction {
  if (!Object.hasOwn(GH_ACTIONS, name)) {
    throw new ActionError(`unknown gh action ${JSON.stringify(name)}`);
  }
  const action = GH_ACTIONS[name];
  if (action === undefined) throw new ActionError(`unknown gh action ${JSON.stringify(name)}`);
  return action;
}

/** A repository as `owner/name`; the slashes are the only structural characters. */
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Build the canonical argv for one action.
 *
 * The caller's keys are checked against the catalog, so an undeclared flag, a wrong type, or a
 * missing required value is refused rather than passed to `gh`. The repository is injected by the
 * broker and is not accepted as a flag value from the caller.
 *
 * @param name - the action name.
 * @param values - the caller's positional and flag values.
 * @param repo - the validated `owner/name` repository to inject as `--repo`.
 * @returns the argv after the `gh` binary.
 * @throws {ActionError} on an unknown action, key, flag type, or missing required value.
 */
export function buildGhArgv(name: string, values: ActionValues, repo: string): string[] {
  const action = getGhAction(name);
  const [owner, repository] = repo.split('/');
  if (
    !REPO.test(repo) ||
    owner === undefined ||
    repository === undefined ||
    owner === '.' ||
    owner === '..' ||
    repository === '.' ||
    repository === '..'
  ) {
    throw new ActionError(`invalid repository ${JSON.stringify(repo)}`);
  }

  const known = new Set<string>([
    ...action.positionals.map((positional) => positional.name),
    ...action.flags.map((flag) => flag.name),
  ]);
  for (const key of Object.keys(values)) {
    if (!known.has(key)) throw new ActionError(`unknown option ${JSON.stringify(key)} for ${name}`);
  }

  const argv = [...action.command];
  for (const positional of action.positionals) {
    const value = values[positional.name];
    if (value === undefined) {
      if (positional.required === true) throw new ActionError(`${name} needs ${positional.name}`);
      continue;
    }
    if (positional.type === 'number') {
      const number = asNumber(value, positional.name);
      argv.push(String(number));
    } else {
      argv.push(asString(value, positional.name));
    }
  }

  const present = new Set<string>();
  for (const flag of action.flags) {
    const value = values[flag.name];
    if (value === undefined) {
      if (flag.required === true) throw new ActionError(`${name} needs --${flag.name}`);
      continue;
    }
    if (flag.type === 'boolean') {
      if (typeof value !== 'boolean') throw new ActionError(`--${flag.name} is a boolean`);
      if (value) {
        argv.push(`--${flag.name}`);
        present.add(flag.name);
      }
      continue;
    }

    if (flag.repeatable === true) {
      for (const item of asStringList(value, flag.name)) {
        argv.push(`--${flag.name}`, flag.type === 'number' ? String(asNumber(item, flag.name)) : item);
      }
    } else if (flag.type === 'number') {
      argv.push(`--${flag.name}`, String(asNumber(value, flag.name)));
    } else {
      argv.push(`--${flag.name}`, asString(value, flag.name));
    }
    present.add(flag.name);
  }

  if (action.exactlyOneOf !== undefined) {
    const chosen = action.exactlyOneOf.filter((flag) => present.has(flag));
    if (chosen.length !== 1) {
      throw new ActionError(`${name} needs exactly one of ${action.exactlyOneOf.map((flag) => `--${flag}`).join(', ')}`);
    }
  }

  argv.push('--repo', repo);
  return argv;
}

/**
 * Convert one value to a positive integer.
 *
 * @param value - the caller's value.
 * @param label - the field name for the error.
 * @returns the integer.
 * @throws {ActionError} when the value is not a positive integer.
 */
function asNumber(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return Number(value);
  throw new ActionError(`${label} must be a positive integer`);
}

/**
 * Convert one value to a string.
 *
 * @param value - the caller's value.
 * @param label - the flag name for the error.
 * @returns the string.
 * @throws {ActionError} when the value is not a string.
 */
function asString(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  throw new ActionError(`${label} must be a string`);
}

/**
 * Convert one value to a list of strings.
 *
 * @param value - the caller's value.
 * @param label - the flag name for the error.
 * @returns the list.
 * @throws {ActionError} when the value is not a string or a list of strings.
 */
function asStringList(value: unknown, label: string): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return [...value];
  throw new ActionError(`${label} must be a string or a list of strings`);
}
