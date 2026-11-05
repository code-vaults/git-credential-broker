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

import { MAX_BODY_CHARS, MAX_TITLE_CHARS } from './host-request.ts';

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
  /** The value must not be empty or whitespace-only. */
  readonly nonEmpty?: boolean;
}

/** A fixed `gh api` request, with only typed values substituted. */
export interface ApiSpec {
  readonly method: 'GET';
  readonly endpoint: string;
}

/** One allowed `gh` action. */
export interface GhAction {
  readonly name: string;
  /** The subcommand after the `gh` binary, e.g. `['pr', 'view']`. */
  readonly command: readonly string[];
  readonly positionals: readonly PositionalSpec[];
  readonly flags: readonly FlagSpec[];
  /** Exactly one of these values (positional or flag) must be present, when set. */
  readonly exactlyOneOf?: readonly string[];
  /** At least one of these flags must be present. */
  readonly atLeastOneOf?: readonly string[];
  /** This body must be present when any of these flags is present. */
  readonly bodyRequiredWith?: readonly string[];
  /** Flag pairs that may not be present together. */
  readonly conflicts?: readonly (readonly [string, string])[];
  /** This action only reads; publicRead may run it on a verified public repository with a metadata-only app token. */
  readonly readOnly?: boolean;
  readonly permissions: Readonly<Partial<Record<GhPermission, PermissionLevel>>>;
  /** The default per-action timeout, in seconds. */
  readonly timeoutSeconds: number;
  /** The object kind this action may target, when the CLI command also accepts the other kind. */
  readonly target?: 'issue' | 'pr';
  /** Whether the app broker may run this with `identity: 'user'`. */
  readonly appUser?: boolean;
  /** When set, the executor runs `gh api` for this fixed request instead of the command above. */
  readonly api?: ApiSpec;
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
  readOnly: true,
  appUser: true,
};

// GitHub: GraphQL repository.pullRequests (gh pr list uses GraphQL)
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
  readOnly: true,
  appUser: true,
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
  readOnly: true,
  appUser: true,
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
};

// GitHub: PATCH /repos/{owner}/{repo}/pulls/{pull_number}
const PR_EDIT: GhAction = {
  name: 'pr:edit',
  command: ['pr', 'edit'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [
    { name: 'title', type: 'string' },
    { name: 'body', type: 'string' },
    { name: 'base', type: 'string' },
  ],
  atLeastOneOf: ['title', 'body', 'base'],
  permissions: { pull_requests: 'write' },
  timeoutSeconds: 120,
  appUser: true,
};

// GitHub: POST /repos/{owner}/{repo}/issues/{issue_number}/comments
const PR_COMMENT: GhAction = {
  name: 'pr:comment',
  command: ['pr', 'comment'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [{ name: 'body', type: 'string', required: true, nonEmpty: true }],
  permissions: { pull_requests: 'write' },
  timeoutSeconds: 120,
};

// GitHub GraphQL: closePullRequest
const PR_CLOSE: GhAction = {
  name: 'pr:close',
  command: ['pr', 'close'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [],
  permissions: { pull_requests: 'write' },
  timeoutSeconds: 60,
};

// GitHub: PATCH /repos/{owner}/{repo}/pulls/{pull_number}
const PR_REOPEN: GhAction = {
  name: 'pr:reopen',
  command: ['pr', 'reopen'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [],
  permissions: { pull_requests: 'write' },
  timeoutSeconds: 60,
};

// GitHub GraphQL: markPullRequestReadyForReview and convertPullRequestToDraft
const PR_READY: GhAction = {
  name: 'pr:ready',
  command: ['pr', 'ready'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [{ name: 'undo', type: 'boolean' }],
  permissions: { pull_requests: 'write' },
  timeoutSeconds: 60,
};

// GitHub GraphQL:
// https://docs.github.com/en/graphql/reference/pulls#mutation-updatepullrequestbranch
const PR_UPDATE_BRANCH: GhAction = {
  name: 'pr:update-branch',
  command: ['pr', 'update-branch'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [{ name: 'rebase', type: 'boolean' }],
  permissions: { pull_requests: 'write', contents: 'write' },
  timeoutSeconds: 120,
  appUser: true,
};

// GitHub GraphQL:
// https://docs.github.com/en/graphql/reference/issues#mutation-locklockable
// https://docs.github.com/en/graphql/reference/issues#mutation-unlocklockable
const PR_LOCK: GhAction = {
  name: 'pr:lock',
  command: ['pr', 'lock'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [{ name: 'reason', type: 'string' }],
  permissions: { pull_requests: 'write' },
  timeoutSeconds: 60,
};

const PR_UNLOCK: GhAction = {
  name: 'pr:unlock',
  command: ['pr', 'unlock'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [],
  permissions: { pull_requests: 'write' },
  timeoutSeconds: 60,
};

// GitHub: GET /repos/{owner}/{repo}/pulls/{number} then its check-runs and commit statuses
const PR_CHECKS: GhAction = {
  name: 'pr:checks',
  command: ['pr', 'checks'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [
    { name: 'fail-fast', type: 'boolean' },
    { name: 'interval', type: 'number' },
    { name: 'jq', type: 'string' },
    { name: 'json', type: 'string' },
    { name: 'required', type: 'boolean' },
    { name: 'template', type: 'string' },
    { name: 'watch', type: 'boolean' },
  ],
  permissions: { pull_requests: 'read', checks: 'read', statuses: 'read' },
  timeoutSeconds: 300,
  readOnly: true,
  appUser: true,
};

// GitHub: the app's authored pull requests and review requests, with checks. A --repo override
// suppresses gh's current-branch section.
const PR_STATUS: GhAction = {
  name: 'pr:status',
  command: ['pr', 'status'],
  positionals: [],
  flags: [
    { name: 'conflict-status', type: 'boolean' },
    { name: 'jq', type: 'string' },
    { name: 'json', type: 'string' },
    { name: 'template', type: 'string' },
  ],
  permissions: { pull_requests: 'read', checks: 'read', statuses: 'read' },
  timeoutSeconds: 120,
  readOnly: true,
  appUser: true,
};

// GitHub: GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}
const PR_REVIEW_BY_ID: GhAction = {
  name: 'pr:review-by-id',
  command: ['pr', 'review-by-id'],
  positionals: [
    { name: 'number', type: 'number', required: true },
    { name: 'id', type: 'number', required: true },
  ],
  flags: [{ name: 'jq', type: 'string' }],
  permissions: { pull_requests: 'read' },
  timeoutSeconds: 120,
  readOnly: true,
  appUser: true,
  api: {
    method: 'GET',
    endpoint: 'repos/{owner}/{repo}/pulls/{number}/reviews/{id}',
  },
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
  bodyRequiredWith: ['comment', 'request-changes'],
  permissions: { pull_requests: 'write' },
  timeoutSeconds: 120,
  appUser: true,
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
  appUser: true,
};

// GitHub: PATCH /repos/{owner}/{repo}/issues/{issue_number}
const ISSUE_EDIT: GhAction = {
  name: 'issue:edit',
  command: ['issue', 'edit'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [
    { name: 'title', type: 'string' },
    { name: 'body', type: 'string' },
  ],
  atLeastOneOf: ['title', 'body'],
  permissions: { issues: 'write' },
  timeoutSeconds: 120,
  appUser: true,
};

// GitHub: POST /repos/{owner}/{repo}/issues/{issue_number}/comments
const ISSUE_COMMENT: GhAction = {
  name: 'issue:comment',
  command: ['issue', 'comment'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [{ name: 'body', type: 'string', required: true, nonEmpty: true }],
  permissions: { issues: 'write' },
  timeoutSeconds: 120,
  appUser: true,
};

// GitHub: PATCH /repos/{owner}/{repo}/issues/{issue_number}
const ISSUE_CLOSE: GhAction = {
  name: 'issue:close',
  command: ['issue', 'close'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [{ name: 'reason', type: 'string' }],
  permissions: { issues: 'write' },
  timeoutSeconds: 60,
  appUser: true,
  target: 'issue',
};

// GitHub: PATCH /repos/{owner}/{repo}/issues/{issue_number}
const ISSUE_REOPEN: GhAction = {
  name: 'issue:reopen',
  command: ['issue', 'reopen'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [],
  permissions: { issues: 'write' },
  timeoutSeconds: 60,
  appUser: true,
  target: 'issue',
};

// GitHub: GET /repos/{owner}/{repo}/issues/{issue_number}
const ISSUE_VIEW: GhAction = {
  name: 'issue:view',
  command: ['issue', 'view'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [
    { name: 'comments', type: 'boolean' },
    { name: 'jq', type: 'string' },
    { name: 'json', type: 'string' },
    { name: 'template', type: 'string' },
  ],
  permissions: { issues: 'read' },
  timeoutSeconds: 120,
  readOnly: true,
  appUser: true,
};

// GitHub: GET /repos/{owner}/{repo}/issues
const ISSUE_LIST: GhAction = {
  name: 'issue:list',
  command: ['issue', 'list'],
  positionals: [],
  flags: [
    { name: 'app', type: 'string' },
    { name: 'assignee', type: 'string' },
    { name: 'author', type: 'string' },
    { name: 'jq', type: 'string' },
    { name: 'json', type: 'string' },
    { name: 'label', type: 'string', repeatable: true },
    { name: 'limit', type: 'number' },
    { name: 'mention', type: 'string' },
    { name: 'milestone', type: 'string' },
    { name: 'search', type: 'string' },
    { name: 'state', type: 'string' },
    { name: 'template', type: 'string' },
    { name: 'type', type: 'string' },
  ],
  permissions: { issues: 'read' },
  timeoutSeconds: 120,
  readOnly: true,
  appUser: true,
};

// GitHub GraphQL:
// https://docs.github.com/en/graphql/reference/issues#mutation-locklockable
// https://docs.github.com/en/graphql/reference/issues#mutation-unlocklockable
const ISSUE_LOCK: GhAction = {
  name: 'issue:lock',
  command: ['issue', 'lock'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [{ name: 'reason', type: 'string' }],
  permissions: { issues: 'write' },
  timeoutSeconds: 60,
  appUser: true,
};

const ISSUE_UNLOCK: GhAction = {
  name: 'issue:unlock',
  command: ['issue', 'unlock'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [],
  permissions: { issues: 'write' },
  timeoutSeconds: 60,
  appUser: true,
};

// GitHub GraphQL:
// https://docs.github.com/en/graphql/reference/issues#mutation-pinissue
// https://docs.github.com/en/graphql/reference/issues#mutation-unpinissue
const ISSUE_PIN: GhAction = {
  name: 'issue:pin',
  command: ['issue', 'pin'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [],
  permissions: { issues: 'write' },
  timeoutSeconds: 60,
  appUser: true,
  target: 'issue',
};

const ISSUE_UNPIN: GhAction = {
  name: 'issue:unpin',
  command: ['issue', 'unpin'],
  positionals: [{ name: 'number', type: 'number', required: true }],
  flags: [],
  permissions: { issues: 'write' },
  timeoutSeconds: 60,
  appUser: true,
  target: 'issue',
};

// GitHub: POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel, or .../force-cancel with --force
const RUN_CANCEL: GhAction = {
  name: 'run:cancel',
  command: ['run', 'cancel'],
  positionals: [{ name: 'runId', type: 'number', required: true }],
  flags: [{ name: 'force', type: 'boolean' }],
  permissions: { actions: 'write' },
  timeoutSeconds: 60,
  appUser: true,
};

// GitHub: POST .../actions/runs/{run_id}/rerun; --failed selects rerun-failed-jobs, and --job
// selects .../actions/jobs/{job_id}/rerun. gh ignores a run id and --failed when --job is present.
const RUN_RERUN: GhAction = {
  name: 'run:rerun',
  command: ['run', 'rerun'],
  positionals: [{ name: 'runId', type: 'number' }],
  flags: [
    { name: 'debug', type: 'boolean' },
    { name: 'failed', type: 'boolean' },
    { name: 'job', type: 'string', nonEmpty: true },
  ],
  exactlyOneOf: ['runId', 'job'],
  conflicts: [['failed', 'job']],
  permissions: { actions: 'write' },
  timeoutSeconds: 120,
  appUser: true,
};

// GitHub: poll GET /repos/{owner}/{repo}/actions/runs/{run_id} until it finishes; fetch
// GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations for annotations
const RUN_WATCH: GhAction = {
  name: 'run:watch',
  command: ['run', 'watch'],
  positionals: [{ name: 'runId', type: 'number', required: true }],
  flags: [
    { name: 'compact', type: 'boolean' },
    { name: 'exit-status', type: 'boolean' },
    { name: 'interval', type: 'number' },
  ],
  permissions: { actions: 'read', checks: 'read' },
  timeoutSeconds: 3300,
  readOnly: true,
  appUser: true,
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
  readOnly: true,
  appUser: true,
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
  readOnly: true,
  appUser: true,
};

/** Every built-in action, keyed by its action name. */
export const GH_ACTIONS: Readonly<Record<string, GhAction>> = Object.freeze({
  'pr:view': PR_VIEW,
  'pr:list': PR_LIST,
  'pr:diff': PR_DIFF,
  'pr:create': PR_CREATE,
  'pr:edit': PR_EDIT,
  'pr:close': PR_CLOSE,
  'pr:reopen': PR_REOPEN,
  'pr:ready': PR_READY,
  'pr:lock': PR_LOCK,
  'pr:unlock': PR_UNLOCK,
  'pr:update-branch': PR_UPDATE_BRANCH,
  'pr:checks': PR_CHECKS,
  'pr:status': PR_STATUS,
  'pr:comment': PR_COMMENT,
  'pr:review': PR_REVIEW,
  'pr:review-by-id': PR_REVIEW_BY_ID,
  'issue:create': ISSUE_CREATE,
  'issue:edit': ISSUE_EDIT,
  'issue:comment': ISSUE_COMMENT,
  'issue:close': ISSUE_CLOSE,
  'issue:reopen': ISSUE_REOPEN,
  'issue:lock': ISSUE_LOCK,
  'issue:unlock': ISSUE_UNLOCK,
  'issue:pin': ISSUE_PIN,
  'issue:unpin': ISSUE_UNPIN,
  'issue:view': ISSUE_VIEW,
  'issue:list': ISSUE_LIST,
  'run:view': RUN_VIEW,
  'run:list': RUN_LIST,
  'run:watch': RUN_WATCH,
  'run:cancel': RUN_CANCEL,
  'run:rerun': RUN_RERUN,
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
 * @param repo - the validated `owner/name` repository, injected as `--repo` for a command
 *   action or substituted into the endpoint for an API action.
 * @param bodyFile - when set, the action's `body` flag is emitted as `--body-file` with this path;
 *   only the path reaches argv.
 * @returns the argv after the `gh` binary.
 * @throws {ActionError} on an unknown action, key, flag type, or missing required value.
 */
export function buildGhArgv(
  name: string,
  values: ActionValues,
  repo: string,
  bodyFile?: string,
): string[] {
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

  let argv: string[];
  if (action.api !== undefined) {
    const substitutions: Record<string, string> = {
      owner,
      repo: repository,
      ...Object.fromEntries(
        action.positionals.flatMap((positional) => {
          const value = values[positional.name];
          if (value === undefined) {
            if (positional.required === true) throw new ActionError(`${name} needs ${positional.name}`);
            return [];
          }
          return [[positional.name, positional.type === 'number' ? String(asNumber(value, positional.name)) : asString(value, positional.name)]];
        }),
      ),
    };
    const endpoint = action.api.endpoint.replace(/\{([a-zA-Z_]+)\}/g, (_match, key: string) => {
      const value = substitutions[key];
      if (value === undefined) throw new ActionError(`${name} has no value for {${key}}`);
      return encodeURIComponent(value);
    });
    if (endpoint.includes('{')) throw new ActionError(`${name} left an endpoint placeholder unresolved`);
    argv = ['api', '--method', action.api.method, endpoint];
  } else {
    argv = [...action.command];
    for (const positional of action.positionals) {
      const value = values[positional.name];
      if (value === undefined) {
        if (positional.required === true) throw new ActionError(`${name} needs ${positional.name}`);
        continue;
      }
      if (positional.type === 'number') {
        argv.push(String(asNumber(value, positional.name)));
      } else {
        argv.push(asString(value, positional.name));
      }
    }
  }

  const present = new Set<string>();
  const provided = new Set<string>();
  for (const positional of action.positionals) {
    if (values[positional.name] !== undefined) provided.add(positional.name);
  }
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
        provided.add(flag.name);
      }
      continue;
    }

    if (flag.name === 'body' && bodyFile !== undefined) {
      const text = asString(value, flag.name);
      if (flag.nonEmpty === true && text.trim() === '') {
        throw new ActionError(`${name} needs a non-empty --${flag.name}`);
      }
      argv.push('--body-file', bodyFile);
      present.add(flag.name);
      continue;
    }
    if (flag.repeatable === true) {
      for (const item of asStringList(value, flag.name)) {
        argv.push(`--${flag.name}`, flag.type === 'number' ? String(asNumber(item, flag.name)) : item);
      }
    } else if (flag.type === 'number') {
      argv.push(`--${flag.name}`, String(asNumber(value, flag.name)));
    } else {
      const text = asString(value, flag.name);
      if (flag.nonEmpty === true && text.trim() === '') {
        throw new ActionError(`${name} needs a non-empty --${flag.name}`);
      }
      argv.push(`--${flag.name}`, text);
    }
    present.add(flag.name);
    provided.add(flag.name);
  }

  if (action.atLeastOneOf !== undefined && !action.atLeastOneOf.some((flag) => present.has(flag))) {
    throw new ActionError(
      `${name} needs at least one of ${action.atLeastOneOf.map((flag) => `--${flag}`).join(', ')}`,
    );
  }
  if (action.exactlyOneOf !== undefined) {
    const chosen = action.exactlyOneOf.filter((field) => provided.has(field));
    if (chosen.length !== 1) {
      const spell = (field: string): string =>
        action.positionals.some((positional) => positional.name === field) ? field : `--${field}`;
      throw new ActionError(
        `${name} needs exactly one of ${action.exactlyOneOf.map(spell).join(', ')}`,
      );
    }
  }
  for (const flag of action.bodyRequiredWith ?? []) {
    if (present.has(flag) && (typeof values.body !== 'string' || values.body.trim() === '')) {
      throw new ActionError(`${name} needs a non-empty --body with --${flag}`);
    }
  }
  for (const [left, right] of action.conflicts ?? []) {
    if (present.has(left) && present.has(right)) {
      throw new ActionError(`${name} does not allow --${left} with --${right}`);
    }
  }

  if (typeof values['title'] === 'string') {
    if (values['title'].trim() === '') {
      throw new ActionError('the title must not be empty');
    }
    if (values['title'].length > MAX_TITLE_CHARS) {
      throw new ActionError(`the title must be at most ${MAX_TITLE_CHARS} characters`);
    }
  }
  if (typeof values['body'] === 'string' && values['body'].length > MAX_BODY_CHARS) {
    throw new ActionError(`the body must be at most ${MAX_BODY_CHARS} characters`);
  }

  if (action.api === undefined) argv.push('--repo', repo);
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
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
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
