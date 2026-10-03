/**
 * Shared types for the broker, the helper and their tests.
 *
 * Everything here is a compile-time-only construct (`interface`/`type`), which keeps the
 * sources erasable: Node can run the `.ts` files directly by stripping the annotations,
 * and `tsc` produces the shipped JavaScript without any runtime helper.
 */

/** A repository reference, normalized out of git's `path=` field. */
export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
  /** The normalized `owner/repo` form used for allowlist matching and audit records. */
  readonly full: string;
}

/** One credential, as handed to git by the helper. */
export interface Credential {
  readonly username: string;
  readonly password: string;
  /** Epoch milliseconds after which this credential must not be reused. */
  readonly expiresAt: number;
  /** Whether the broker answered from its cache instead of minting. */
  readonly cached?: boolean;
}

/** What a provider is asked to produce a credential for. */
export interface CredentialRequest {
  /** The configured host key, not the raw value the client sent. */
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly full: string;
}

/** A credential source for exactly one host. */
export interface Provider {
  readonly name: string;
  getCredential(request: CredentialRequest): Promise<Credential>;
  /**
   * Read one workflow job's log, when this provider can.
   *
   * Optional, and separate from {@link Provider.getCredential} on purpose: reading a log is not
   * minting a credential. The broker refuses the operation when a provider does not implement it.
   */
  getJobLog?(request: JobLogRequest): Promise<JobLog>;
  /**
   * Open one pull request, when this provider can.
   *
   * Separate from {@link Provider.getCredential} for the same reason as {@link Provider.getJobLog}:
   * the token this mints asks for what a pull request needs, and nothing that a push needs.
   */
  pullRequest?(request: PullRequestRequest): Promise<PullRequest>;
}

/** What a provider is asked to read a log for. */
export interface JobLogRequest {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  /** The workflow job id, which is also the check run id. */
  readonly jobId: number;
}

/** What can be done to a pull request. */
export type PullRequestAction =
  | 'open'
  | 'close'
  | 'merge'
  | 'update'
  | 'status'
  | 'comment'
  | 'threads'
  | 'reply'
  | 'edit'
  | 'resolve';

/** How a merge should be recorded. */
export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** What a provider is asked to do to a pull request. */
export interface PullRequestRequest {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
  readonly action: PullRequestAction;
  /** The pull request number. Not needed to open one, to resolve a thread, or to edit a comment. */
  readonly number?: number;
  /** The review comment being answered or changed, for `action: "reply"` or `"edit"`. */
  readonly commentId?: number;
  /** The review thread being resolved, for `action: "resolve"`. */
  readonly threadId?: string;
  /** The branch holding the change, when opening. */
  readonly head?: string;
  /** The branch it merges into. */
  readonly base?: string;
  readonly title?: string;
  readonly body?: string;
  /** The file a review comment is anchored to, repository-relative, without a leading slash. */
  readonly filePath?: string;
  /** The line in that file: in the new file for `side: "right"`, in the old one for `"left"`. */
  readonly line?: number;
  /** Which side of the diff the line counts on. The new file, unless told otherwise. */
  readonly side?: 'left' | 'right';
  readonly draft?: boolean;
  readonly method?: MergeMethod;
}

/** One pull request, as GitHub describes it after an action. */
export interface PullRequest {
  readonly number: number;
  readonly url: string;
  /** `open` or `closed`, when GitHub said. */
  readonly state?: string;
  /** Whether the action merged it. */
  readonly merged?: boolean;
  /** A short report, when the action was to look. */
  readonly status?: string;
}

/** One job log, as returned to the caller. */
export interface JobLog {
  readonly text: string;
  /** Whether the provider cut the log short, which it says in the text too. */
  readonly truncated: boolean;
}

/** Fields every host block shares. */
export interface BaseHostConfig {
  /** Default-deny allowlist of `owner/repo` entries; a whole segment may be a wildcard. */
  readonly allow: readonly string[];
  /**
   * Whether a plaintext `http` remote is acceptable for this host.
   *
   * Off by default, and deliberately a *broker-side* decision: it is read from host-side
   * configuration the agent cannot edit, so nothing running in the container can widen it.
   * It exists for a self-hosted forge reached over a trusted network, and for the test
   * suite's local plaintext git server.
   */
  readonly allowInsecureHttp?: boolean;
}

/** Host block backed by one fixed username/password pair. */
export interface StaticHostConfig extends BaseHostConfig {
  readonly provider: 'static';
  readonly username?: string;
  readonly password?: string;
  readonly passwordPath?: string;
  readonly passwordEnv?: string;
  readonly expiresInSeconds?: number;
}

/** Host block backed by a GitHub App installation access token. */
export interface GithubAppHostConfig extends BaseHostConfig {
  readonly provider: 'github-app';
  /** Preferred `iss` claim. */
  readonly clientId?: string;
  /** Fallback `iss` claim when no client ID is configured. */
  readonly appId?: string | number;
  readonly privateKeyPath?: string;
  /**
   * A person's fine-grained tokens, keyed by the owner whose repositories they cover.
   *
   * Keyed by owner because that is GitHub's own granularity: a fine-grained token belongs to one
   * user or organization and cannot span two. Scoped as the README says — pull requests read and
   * write, contents read, metadata read, and only the repositories the allowlist names — GitHub
   * itself refuses to let such a token push or merge, because neither is possible without contents
   * write. Used for creating and resolving a pull request, and nothing else; every other action stays on the app.
   */
  readonly userTokens?: Readonly<Record<string, string>>;
  readonly privateKeyPem?: string;
  /** REST permission names, e.g. `{ contents: 'write', pull_requests: 'write' }`. */
  readonly permissions?: Readonly<Record<string, string>>;
  readonly apiBaseUrl?: string;
  readonly apiVersion?: string;
  readonly installationCacheSeconds?: number;
  /**
   * Whether to confirm, once per process, that the app is actually granted every permission
   * the token request will ask for. Defaults to true: GitHub answers 422 for an ungranted
   * permission, which is easy to mistake for a broker fault.
   */
  readonly verifyAppPermissions?: boolean;
}

/** One configured host. */
export type HostConfig = StaticHostConfig | GithubAppHostConfig;

/** A validated broker configuration. */
export interface BrokerConfig {
  readonly socketPath: string;
  readonly socketMode: number;
  readonly auditPath: string | null;
  readonly tokenCacheSkewSeconds: number;
  readonly hosts: Readonly<Record<string, HostConfig>>;
}

/** One request line on the broker socket. */
export interface WireRequest {
  readonly op: string;
  readonly protocol?: string;
  readonly host?: string;
  readonly path?: string;
  readonly session?: string | null;
  readonly pid?: number;
  /** Workflow job id, for `op: "logs"`. */
  readonly jobId?: number;
  /** For `op: "pull-request"`. */
  readonly action?: string;
  readonly number?: number;
  readonly commentId?: number;
  readonly threadId?: string;
  readonly method?: string;
  readonly head?: string;
  readonly base?: string;
  readonly title?: string;
  readonly body?: string;
  readonly draft?: boolean;
}

/** One response line on the broker socket. */
export interface WireResponse {
  readonly ok: boolean;
  readonly code?: string;
  readonly reason?: string;
  readonly username?: string;
  readonly password?: string;
  readonly expires_at?: string;
  readonly version?: string;
  readonly hosts?: readonly string[];
  /** The job log, for `op: "logs"`. */
  readonly log?: string;
  readonly truncated?: boolean;
  /** The opened pull request, for `op: "pull-request"`. */
  readonly prUrl?: string;
  readonly prNumber?: number;
  readonly prState?: string;
  readonly prMerged?: boolean;
  /** The report, for `action: "status"`. */
  readonly prStatus?: string;
}

/** Where audit records go. */
export interface AuditSink {
  readonly path: string | null;
  record(event: Record<string, unknown>): void;
  close(): Promise<void>;
}

/**
 * The slice of the Fetch API the GitHub App provider uses.
 *
 * Declared structurally rather than as `typeof fetch` so tests can inject a stub without
 * casts, and so the provider never depends on ambient DOM/Node fetch types.
 */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** The request half of {@link FetchLike}. */
export interface FetchInitLike {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

/** A minimal fetch implementation. */
export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;
