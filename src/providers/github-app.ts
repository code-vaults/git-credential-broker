/**
 * GitHub App provider: the broker mints a short-lived installation access token with
 * `node:crypto` only, so the host needs no `openssl`, no SDK and no runtime dependency.
 *
 * Everything GitHub documents as a prerequisite for a successful mint is implemented
 * explicitly, because each omission fails in a way that is painful to diagnose:
 *  - `RS256` signature;
 *  - `iat` one minute in the past (clock drift);
 *  - `exp` at most ten minutes after `iat`;
 *  - `iss` set to the client ID when configured, otherwise the app ID;
 *  - the account's installation is resolved by matching `account.login` case-insensitively,
 *    which is what makes multiple owners work;
 *  - the token is scoped to exactly one repository by name (`repositories` takes the
 *    repository name, not `owner/name`) and to explicitly narrowed permissions;
 *  - a minted token is cached and reused until shortly before it expires, instead of being
 *    re-minted on every helper invocation.
 *
 * Reference: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
import { createSign } from 'node:crypto';
import { ProviderConfigError } from '../errors.ts';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { refreshUserToken } from '../device-flow.ts';

import type { Credential, FetchLike, FetchResponseLike, GithubAppHostConfig, Provider } from '../types.ts';
import type { JobLog, JobLogRequest } from '../types.ts';
import type { PullRequest, PullRequestRequest } from '../types.ts';

/** REST API origin. Overridable for GitHub Enterprise. */
const DEFAULT_API = 'https://api.github.com';

/** GitHub refuses a JWT whose `exp` is more than this many seconds after `iat`. */
const MAX_JWT_LIFETIME_SECONDS = 600;

/** Access levels, ordered, so a requested level can be compared against the granted one. */
const ACCESS_LEVELS: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** One account's installation of this app. */
interface CachedInstallation {
  readonly id: number;
  readonly expiresAt: number;
}

/** Options for {@link createGithubAppProvider}. */
export interface GithubAppProviderOptions {
  /** The host this provider serves. */
  readonly host: string;
  readonly cfg: GithubAppHostConfig;
  /** Re-mint a cached token this many seconds before it expires. */
  readonly skewSeconds?: number;
  /** Transport, injectable for tests. */
  readonly fetchImpl?: FetchLike;
  /** Clock, injectable for tests. */
  readonly now?: () => number;
}

/** Options for {@link signAppJwt}. */
export interface SignAppJwtOptions {
  readonly privateKeyPem: string;
  readonly iss: string | number;
  readonly nowMs: number;
  readonly lifetimeSeconds?: number;
  readonly skewSeconds?: number;
}

/**
 * Base64url-encode a string or buffer, without padding, as JWS requires.
 *
 * @param input - the value to encode.
 * @returns the base64url encoding.
 */
export function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * Sign a GitHub App JWT.
 *
 * @param options - signing options.
 * @returns the compact JWS.
 * @throws {Error} when required inputs are missing or the lifetime exceeds GitHub's limit.
 */
export function signAppJwt(options: SignAppJwtOptions): string {
  const { privateKeyPem, iss, nowMs, lifetimeSeconds = MAX_JWT_LIFETIME_SECONDS, skewSeconds = 60 } = options;
  if (!privateKeyPem) throw new Error('signAppJwt: privateKeyPem is required');
  if (iss === undefined || iss === null || iss === '') {
    throw new Error('signAppJwt: iss (client ID or app ID) is required');
  }
  if (lifetimeSeconds > MAX_JWT_LIFETIME_SECONDS) {
    throw new Error(
      `signAppJwt: exp must be at most ${MAX_JWT_LIFETIME_SECONDS} seconds after iat (GitHub rejects anything longer)`,
    );
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const header = { typ: 'JWT', alg: 'RS256' };
  const payload = {
    iat: nowSeconds - skewSeconds,
    exp: nowSeconds + lifetimeSeconds,
    iss: String(iss),
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * Extract the `rel="next"` URL from a `Link` header.
 *
 * @param linkHeader - the raw header value.
 * @returns the next page URL, or null when there is none.
 */
export function nextLink(linkHeader: string | null): string | null {
  if (typeof linkHeader !== 'string') return null;
  for (const part of linkHeader.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    const url = match?.[1];
    if (url) return url;
  }
  return null;
}

/**
 * Build a GitHub App provider for one host.
 *
 * @param options - provider options.
 * @returns the provider.
 * @throws {Error} when the private key or app identity is missing (fail fast).
 */
export function createGithubAppProvider(options: GithubAppProviderOptions): Provider {
  const { host, cfg, skewSeconds = 300, fetchImpl = globalThis.fetch, now = () => Date.now() } = options;

  const privateKeyPem = cfg.privateKeyPem
    ? cfg.privateKeyPem
    : cfg.privateKeyPath
      ? readFileSync(cfg.privateKeyPath, 'utf8')
      : null;
  if (!privateKeyPem) {
    throw new Error(`github-app provider for ${host}: privateKeyPath (or privateKeyPem) is required`);
  }
  const keyPem: string = privateKeyPem;

  // Captured as an explicitly-typed local so the narrowing survives into `call`, which is
  // invoked later: `cfg.clientId ?? cfg.appId` is `string | number | undefined`.
  const issuer: string | number | undefined = cfg.clientId ?? cfg.appId;
  if (issuer === undefined || issuer === null || issuer === '') {
    throw new Error(`github-app provider for ${host}: clientId (preferred) or appId is required`);
  }
  const iss: string | number = issuer;

  const api = cfg.apiBaseUrl ?? DEFAULT_API;
  const apiVersion = cfg.apiVersion ?? '2022-11-28';
  const permissions = cfg.permissions ?? { contents: 'write' };
  const checkPermissions = cfg.verifyAppPermissions !== false;
  const installationTtlMs =
    (typeof cfg.installationCacheSeconds === 'number' ? cfg.installationCacheSeconds : 600) * 1000;

  /**
   * What a log read asks for: nothing but the log.
   *
   * Deliberately not the configured `permissions`, which describe the credential git needs. A token
   * minted for those should not also be able to read CI logs, so a log read gets its own token,
   * narrowed to `actions: read`. Whether the agent may read logs at all is then a question about the
   * app's grant, not about anything running in the container.
   */
  const LOG_PERMISSIONS: Record<string, string> = { actions: 'read' };

  /** How much of one log to return: enough to diagnose, bounded so one response stays sane. */
  const LOG_LIMIT_CHARS = 200_000;

  /**
   * What opening a pull request asks for: the permission the operation needs, plus read access to
   * the branches it names. Not the configured `permissions`, for the same reason a log read is not:
   * a token minted for git should not also be able to open a pull request.
   */
  const PULL_REQUEST_PERMISSIONS: Record<string, string> = { pull_requests: 'write', contents: 'read' };

  /** owner login (lowercased) -> installation */
  const installations = new Map<string, CachedInstallation>();
  /** owner/repo -> minted credential */
  const tokens = new Map<string, Credential>();
  /** Cached pre-flight result, per owner: installations differ, so the answer does too. */
  const permissionsChecked = new Map<string, Promise<void>>();

  /**
   * Name every configured permission a grant does not cover.
   *
   * @param granted - the permission map to check against.
   * @param from - how to refer to that map in the message.
   * @param absent - how to describe a permission that is missing entirely.
   * @returns one message per problem; empty when the grant covers the configuration.
   */
  function missingPermissions(
    wantedPermissions: Readonly<Record<string, string>>,
    granted: Record<string, string>,
    from: string,
    absent: string,
  ): string[] {
    const problems: string[] = [];
    for (const [name, wanted] of Object.entries(wantedPermissions)) {
      const have = granted[name];
      if (!have) {
        problems.push(`${name}: ${absent}`);
        continue;
      }
      if ((ACCESS_LEVELS[wanted] ?? 0) > (ACCESS_LEVELS[have] ?? 0)) {
        problems.push(`${name}: requested "${wanted}" but ${from} only has "${have}"`);
      }
    }
    return problems;
  }

  /**
   * Call the REST API with a freshly signed app JWT.
   *
   * @param method - HTTP method.
   * @param url - absolute URL.
   * @param body - optional JSON body.
   * @returns the parsed body and the Link header.
   * @throws {Error} for a non-2xx response.
   */
  async function call(
    method: string,
    url: string,
    body?: Record<string, unknown>,
  ): Promise<{ json: unknown; link: string | null }> {
    const jwt = signAppJwt({ privateKeyPem: keyPem, iss, nowMs: now() });
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt}`,
      'x-github-api-version': apiVersion,
      'user-agent': 'git-credential-broker',
    };
    if (body) headers['content-type'] = 'application/json';

    const response: FetchResponseLike = await fetchImpl(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const text = await response.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!response.ok) {
      const message =
        json !== null && typeof json === 'object' && 'message' in json
          ? String((json as { message: unknown }).message)
          : text.slice(0, 200);
      // The URL is safe to log (no secret); neither the JWT nor any token is included.
      throw new Error(`GitHub API ${method} ${url.replace(api, '')} failed with ${response.status}: ${message}`);
    }
    return { json, link: response.headers.get('link') };
  }

  /**
   * Call the REST API with one installation token, returning the body as text.
   *
   * Used for job logs, whose response is plain text behind a redirect to a signed URL that needs no
   * authorization — fetch drops the header across origins, which is what GitHub intends.
   *
   * @param method - HTTP method.
   * @param url - absolute URL.
   * @param token - the installation token to authenticate with.
   * @returns the status and the body text.
   * @throws {Error} for a non-2xx response.
   */
  async function callWithToken(
    method: string,
    url: string,
    token: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; text: string }> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': apiVersion,
      'user-agent': 'git-credential-broker',
    };
    if (body) headers['content-type'] = 'application/json';

    const response = await fetchImpl(url, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      // The URL is safe to name — the token is a header, not part of it — but the body is not, so
      // this message carries only the endpoint and the status. It is marked as ours, which is what
      // lets the pusher see it instead of "see the broker log".
      throw new ProviderConfigError(
        `GitHub API ${method} ${url.replace(api, '')} answered ${response.status} for that request`,
      );
    }
    return { status: response.status, text };
  }

  /**
   * Resolve the installation id for an account, cached per owner.
   *
   * @param owner - the repository owner as it appeared in the path.
   * @returns the installation id.
   * @throws {Error} when this app is not installed for that account.
   */
  async function resolveInstallationId(owner: string): Promise<number> {
    const key = owner.toLowerCase();
    const cached = installations.get(key);
    if (cached && cached.expiresAt > now()) return cached.id;

    let url: string | null = `${api}/app/installations?per_page=100`;
    for (let page = 0; page < 10 && url; page += 1) {
      const { json, link } = await call('GET', url);
      if (Array.isArray(json)) {
        for (const entry of json) {
          const installation = entry as { id?: unknown; account?: { login?: unknown } };
          const login = installation.account?.login;
          if (typeof login === 'string' && login.toLowerCase() === key && typeof installation.id === 'number') {
            installations.set(key, { id: installation.id, expiresAt: now() + installationTtlMs });
            return installation.id;
          }
        }
      }
      url = nextLink(link);
    }
    throw new Error(`no installation of this app has access to account "${owner}"`);
  }

  /**
   * Confirm both grants cover every permission the token request will ask for.
   *
   * Two checks, because there are two ceilings. The app's permissions are what the app may ask for at
   * all; the **installation's** are what it actually has, and a permission can be granted on the app
   * while an installation has not approved the update. Checking only the app passes in that case and
   * then fails at the token request, where the message is GitHub's and so cannot be handed to the
   * container — which is how a permission problem became "see the broker log".
   *
   * Cached per owner, since installations differ; a failed check is not cached, so fixing the
   * settings does not require restarting the broker.
   *
   * @param owner - the account whose installation will be asked for a token.
   * @returns resolves when the configured permissions are a subset of both grants.
   * @throws {ProviderConfigError} naming each permission that is missing or granted at a lower level.
   */
  function ensurePermissions(
    owner: string,
    wantedPermissions: Readonly<Record<string, string>> = permissions,
  ): Promise<void> {
    if (!checkPermissions) return Promise.resolve();
    // Keyed by both, because a log read checks a different set than a credential does.
    const key = `${owner.toLowerCase()}|${Object.entries(wantedPermissions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, level]) => `${name}=${level}`)
      .join(',')}`;
    const cached = permissionsChecked.get(key);
    if (cached) return cached;

    const pending = (async (): Promise<void> => {
      const { json } = await call('GET', `${api}/app`);
      const appGranted = (json as { permissions?: Record<string, string> } | null)?.permissions ?? {};
      const problems = missingPermissions(
        wantedPermissions,
        appGranted,
        'the app',
        'the app is not granted this permission at all',
      );

      const installationId = await resolveInstallationId(owner);
      const { json: installation } = await call('GET', `${api}/app/installations/${installationId}`);
      const installationGranted =
        (installation as { permissions?: Record<string, string> } | null)?.permissions ?? {};
      problems.push(
        ...missingPermissions(
          wantedPermissions,
          installationGranted,
          'this installation',
          'this installation has not approved it',
        ),
      );

      if (problems.length > 0) {
        throw new ProviderConfigError(
          `the configured permissions for ${host} are not available (${problems.join('; ')}); ` +
            'grant them on the app, approve the update on the installation, or lower `permissions` ' +
            'in the broker config, or set "verifyAppPermissions": false to skip this check',
        );
      }
    })().catch((error: unknown) => {
      permissionsChecked.delete(key);
      throw error;
    });

    permissionsChecked.set(key, pending);
    return pending;
  }

    /**
     * Read a pull request that another call has already fetched.
     *
     * @param text - the JSON body.
     * @param fallbackNumber - the number the caller asked about.
     * @returns the number, URL and state.
     */
    function readPullRequest(text: string): PullRequest {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const payload = (parsed ?? {}) as { number?: unknown; html_url?: unknown; state?: unknown; merged?: unknown };
      if (typeof payload.number !== 'number' || typeof payload.html_url !== 'string') {
        throw new ProviderConfigError('GitHub did not answer with a pull request');
      }
      return {
        number: payload.number,
        url: payload.html_url,
        state: typeof payload.state === 'string' ? payload.state : undefined,
        merged: payload.merged === true,
      };
    }

  /**
   * Report what a pull request is, and how its commit is doing.
   *
   * Two reads: the pull request itself, which carries `mergeable_state`, and the workflow runs for
   * its head commit — the second is what separates "the checks are red" from "the ruleset wants a
   * review", which `mergeable_state: blocked` alone cannot. Both are repository-scoped, so the
   * allowlist binds them.
   *
   * @param request - which pull request.
   * @param token - the installation token.
   * @param collection - the repository's pull request route.
   * @returns the number, URL, state and a short report.
   */
  async function readPullRequestStatus(
    request: PullRequestRequest,
    token: string,
    collection: string,
  ): Promise<PullRequest> {
    const { text } = await callWithToken('GET', `${collection}/${request.number}`, token);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const payload = (parsed ?? {}) as {
      number?: unknown;
      html_url?: unknown;
      state?: unknown;
      merged?: unknown;
      mergeable_state?: unknown;
      draft?: unknown;
      head?: { sha?: unknown };
    };
    if (typeof payload.number !== 'number' || typeof payload.html_url !== 'string') {
      throw new ProviderConfigError('GitHub did not answer with a pull request');
    }

    const lines = [
      `#${payload.number} ${String(payload.state ?? '?')}${payload.merged === true ? ' (merged)' : ''}${payload.draft === true ? ' (draft)' : ''}`,
      payload.html_url,
    ];
    if (typeof payload.mergeable_state === 'string') {
      lines.push(`mergeable: ${payload.mergeable_state}`);
    }

    const sha = (payload.head ?? {}).sha;
    if (typeof sha === 'string' && sha !== '') {
      const { text: listed } = await callWithToken(
        'GET',
        `${api}/repos/${request.owner}/${request.repo}/actions/runs?head_sha=${sha}&per_page=20`,
        token,
      );
      let runs: unknown = null;
      try {
        runs = JSON.parse(listed);
      } catch {
        runs = null;
      }
      const batch = ((runs ?? {}) as { workflow_runs?: unknown }).workflow_runs;
      if (Array.isArray(batch) && batch.length > 0) {
        for (const run of batch as Array<{ name?: unknown; status?: unknown; conclusion?: unknown }>) {
          lines.push(`run ${String(run.name ?? '?')}: ${String(run.conclusion ?? run.status ?? '?')}`);
        }
      } else {
        lines.push('no workflow run for that commit yet');
      }
    }

    return {
      number: payload.number,
      url: payload.html_url,
      state: typeof payload.state === 'string' ? payload.state : undefined,
      merged: payload.merged === true,
      status: lines.join('\n'),
    };
  }

      let cachedPersonToken: { token: string; until: number } | undefined;

/**
 * One more sentence about a failure, when there is one worth having.
 *
 * `fetch failed` is the whole message undici gives for a connection problem and it names nothing useful;
 * the reason is on `cause`. This is for the host log, so it is allowed to carry detail.
 *
 * @param error - whatever was thrown.
 * @returns an empty string, or ` (the reason)`.
 */
function describeCause(error: unknown): string {
  const cause = (error as { cause?: { message?: unknown } } | null)?.cause?.message;
  return typeof cause === 'string' && cause !== '' ? ` (${cause})` : '';
}

  return {
    name: 'github-app',

    async getCredential(request): Promise<Credential> {
      const cached = tokens.get(request.full);
      if (cached && cached.expiresAt - now() > skewSeconds * 1000) {
        return { ...cached, cached: true };
      }

      await ensurePermissions(request.owner);
      const installationId = await resolveInstallationId(request.owner);
      const { json } = await call('POST', `${api}/app/installations/${installationId}/access_tokens`, {
        repositories: [request.repo],
        permissions,
      });

      const payload = (json ?? {}) as { token?: unknown; expires_at?: unknown };
      if (typeof payload.token !== 'string' || !payload.token) {
        throw new Error('GitHub API returned no token for the installation access token request');
      }
      const expiresAt =
        typeof payload.expires_at === 'string' ? Date.parse(payload.expires_at) : now() + 3_600_000;

      const credential: Credential = {
        username: 'x-access-token',
        password: payload.token,
        expiresAt,
      };
      tokens.set(request.full, credential);
      return { ...credential, cached: false };
    },
    /**
     * Read one workflow job's log.
     *
     * One call, to the repository-scoped route: the repository is part of the URL, so the allowlist
     * binds the job id by construction. The global route is keyed by job id alone — an allowlisted
     * repository could name any job this app can see — and it is the one that answers "Must have
     * admin rights", which is a permission this broker should never want.
     *
     * @param request - the job to read.
     * @returns the log text, bounded.
     */
    async getJobLog(request: JobLogRequest): Promise<JobLog> {
      await ensurePermissions(request.owner, LOG_PERMISSIONS);
      const installationId = await resolveInstallationId(request.owner);
      const { json } = await call('POST', `${api}/app/installations/${installationId}/access_tokens`, {
        repositories: [request.repo],
        permissions: LOG_PERMISSIONS,
      });
      const token = (json as { token?: unknown } | null)?.token;
      if (typeof token !== 'string' || !token) {
        throw new ProviderConfigError('GitHub returned no installation token for the log request');
      }

      let text: string;
      try {
        const body = await callWithToken(
          'GET',
          `${api}/repos/${request.owner}/${request.repo}/actions/jobs/${request.jobId}/logs`,
          token,
        );
        text = body.text;
      } catch (error) {
        // A 404 here has two ordinary causes, and neither is a broker fault: the job is not in that
        // repository, or the run it belongs to has not finished — the endpoint serves no log at all
        // while a job is still running.
        throw new ProviderConfigError(
          `${(error as Error).message}; the job has to exist in that repository, and a run that is still in progress has no log yet`,
        );
      }
      if (text.length <= LOG_LIMIT_CHARS) return { text, truncated: false };
      return {
        text: `${text.slice(0, LOG_LIMIT_CHARS)}\n… log truncated at ${LOG_LIMIT_CHARS} characters\n`,
        truncated: true,
      };
    },

    /**
     * Open one pull request.
     *
     * The same shape as a log read: its own token, narrowed to what the operation needs, and the
     * repository-scoped route, so the allowlist binds it by construction.
     *
     * @param request - the branches and the text.
     * @returns the number and the URL GitHub answered with.
     */
    async pullRequest(request: PullRequestRequest): Promise<PullRequest> {
      await ensurePermissions(request.owner, PULL_REQUEST_PERMISSIONS);
      const installationId = await resolveInstallationId(request.owner);
      const { json: minted } = await call('POST', `${api}/app/installations/${installationId}/access_tokens`, {
        repositories: [request.repo],
        permissions: PULL_REQUEST_PERMISSIONS,
      });
    const token = (minted as { token?: unknown } | null)?.token;
      if (typeof token !== 'string' || !token) {
        throw new ProviderConfigError('GitHub returned no installation token for the pull request');
      }

      // Resolved before the branches: by the time the creating and resolving paths run, the action
      // has been narrowed, and asking here is what keeps this call where it is needed.
      const personToken =
        request.action === 'open' || request.action === 'resolve' ? await personalToken() : undefined;

      const collection = `${api}/repos/${request.owner}/${request.repo}/pulls`;


      /**
       * The token of the person this deployment authorized, when there is one.

       * Only two actions may use it, and both because an installation token cannot: GitHub will not
       * author a pull request as a person for an app, and refuses to resolve a review thread for one.
       * The refresh token lives beside the private key, and GitHub rotates it on every use, so the new
       * one is written back — keeping the old would work once and then stop.
       *
       * @returns the user token, or `undefined` when nobody has authorized one.
       */
      async function personalToken(): Promise<string | undefined> {
        if (cfg.clientId === undefined || cfg.privateKeyPath === undefined) return undefined;
        const path = join(dirname(cfg.privateKeyPath), 'user.refresh');
        if (!existsSync(path)) return undefined;
        const now = Date.now();
        if (cachedPersonToken !== undefined && cachedPersonToken.until > now + 60_000) {
          return cachedPersonToken.token;
        }
        const held = readFileSync(path, 'utf8').trim();
        let next;
        try {
          next = await refreshUserToken(cfg.clientId, held, (url, init) => fetchImpl(url, init));
        } catch (error) {
          // This is the one place a renewal failure is explained: the caller is an action that failed,
          // and "fetch failed" on its own names neither the host nor the reason.
          throw new Error(
            `could not renew the authorized token from ${path}: ${(error as Error).message}${describeCause(error)}`,
          );
        }
        if (next.refreshToken !== undefined) writeFileSync(path, `${next.refreshToken}\n`, { mode: 0o600 });
        cachedPersonToken = { token: next.token, until: now + (next.expiresInSeconds ?? 28_800) * 1_000 };
        return cachedPersonToken.token;
      }

      if (request.action === 'resolve') {
        // Resolving has no REST endpoint either. The thread id is the one `--threads` prints.
        const { text: raw } = await callWithToken('POST', `${api}/graphql`, personToken ?? token, {
          query:
            'mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{isResolved}}}',
          variables: { threadId: request.threadId ?? '' },
        });
        let answer: unknown = null;
        try {
          answer = JSON.parse(raw);
        } catch {
          answer = null;
        }
        const state = (answer ?? {}) as {
          data?: { resolveReviewThread?: { thread?: { isResolved?: unknown } } };
          errors?: unknown;
        };
        // A plain Error, not a ProviderConfigError: GraphQL answers in a response body, and those
        // are not passed to the container.
        if (Array.isArray(state.errors) && state.errors.length > 0) {
          // The reason belongs in the host log, which is where a plain Error goes: the broker answers
          // the container generically for one, so nothing from a response body crosses the socket.
          throw new Error(`GitHub refused to resolve that review thread: ${JSON.stringify(state.errors).slice(0, 300)}`);
        }
        return {
          number: request.number ?? 0,
          url: '',
          status: state.data?.resolveReviewThread?.thread?.isResolved === true ? 'resolved' : 'still open',
        };
      }

      if (request.action === 'reply') {
        // A reply belongs in the thread it answers. The issues API would need `issues: write` and
        // would start a new conversation instead of joining one.
        await callWithToken(
          'POST',
          `${collection}/${request.number}/comments/${String(request.commentId ?? 0)}/replies`,
          token,
          { body: request.body ?? '' },
        );
        return { number: request.number ?? 0, url: '' };
      }

      if (request.action === 'threads') {
        // GraphQL, because review threads have no REST list. The repository and the number are
        // named here, so the allowlist still decides what can be reached.
        const { text: raw } = await callWithToken('POST', `${api}/graphql`, token, {
          query:
            'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:50){nodes{id isResolved path line comments(first:10){nodes{databaseId author{login} body}}}}}}}',
          variables: { owner: request.owner, name: request.repo, number: request.number },
        });
        let listed: unknown = null;
        try {
          listed = JSON.parse(raw);
        } catch {
          listed = null;
        }
        // Nothing from a response body reaches the container — the broker answers with a generic
        // message for an ordinary Error — but the host log is where a reason belongs, and a refusal
        // that reads as "no threads" is worse than one that reads as a refusal.
        const refused = (listed ?? {}) as { errors?: unknown };
        if (Array.isArray(refused.errors) && refused.errors.length > 0) {
          throw new Error(`GitHub refused to list the review threads: ${JSON.stringify(refused.errors).slice(0, 300)}`);
        }
        const data = (listed ?? {}) as {
          data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown } } } };
        };
        const nodes = data.data?.repository?.pullRequest?.reviewThreads?.nodes;
        const report: string[] = [];
        if (Array.isArray(nodes)) {
          for (const node of nodes as Array<{
            id?: unknown;
            isResolved?: unknown;
            path?: unknown;
            line?: unknown;
            comments?: { nodes?: unknown };
          }>) {
            report.push(
              `${node.isResolved === true ? 'resolved' : 'open    '} ${String(node.id ?? '')}  ${String(node.path ?? '')}:${String(node.line ?? '')}`,
            );
            const comments = node.comments?.nodes;
            if (!Array.isArray(comments)) continue;
            for (const comment of comments as Array<{
              databaseId?: unknown;
              author?: { login?: unknown };
              body?: unknown;
            }>) {
              const first = String(comment.body ?? '').split('\n')[0] ?? '';
              report.push(`    ${String(comment.databaseId ?? '')} @${String(comment.author?.login ?? '?')}: ${first.slice(0, 120)}`);
            }
          }
        }
        return {
          number: request.number ?? 0,
          url: '',
          status: report.length > 0 ? report.join('\n') : 'no review threads on this pull request',
        };
      }

      if (request.action === 'comment') {
        // A review with no verdict: GitHub shows it as a comment on the pull request, and it needs
        // only the pull request permission the app already has. A *conversation* comment would be the
        // issues API, which needs `issues: write` — see the README.
        await callWithToken('POST', `${collection}/${request.number}/reviews`, token, {
          body: request.body ?? '',
          event: 'COMMENT',
        });
        const { text: after } = await callWithToken('GET', `${collection}/${request.number}`, token);
        let read: unknown = null;
        try {
          read = JSON.parse(after);
        } catch {
          read = null;
        }
        const html = (read ?? {}) as { html_url?: unknown };
        return {
          number: request.number ?? 0,
          url: typeof html.html_url === 'string' ? html.html_url : '',
        };
      }

      if (request.action === 'status') {
        return readPullRequestStatus(request, token, collection);
      }
      let method = 'POST';
      let url = collection;
      let body: Record<string, unknown> = { title: request.title, body: request.body, head: request.head, base: request.base, draft: request.draft === true };
      if (request.action === 'close') {
        method = 'PATCH';
        url = `${collection}/${request.number}`;
        body = { state: 'closed' };
      } else if (request.action === 'update') {
        method = 'PATCH';
        url = `${collection}/${request.number}`;
        body = { title: request.title, body: request.body, base: request.base };
        for (const [key, value] of Object.entries(body)) {
          if (value === undefined) delete body[key];
        }
      } else if (request.action === 'merge') {
        method = 'PUT';
        url = `${collection}/${request.number}/merge`;
        body = { merge_method: request.method ?? 'squash' };
      }

      let text: string;
      try {
        // Creating with the person's token when the deployment has one: GitHub records the pull request
        // as theirs, which is what automated reviewers recognise. It cannot push or merge — the token
        // has no contents write — and every other action stays on the app's installation token.
        // Creating a pull request as a person, and resolving a review thread: the two things an
        // installation token is refused for. A token per owner is the older, narrower way and is still
        // used when there is one; the authorized token answers for every owner at once.
        const tokenPath = request.action === 'open' ? cfg.userTokens?.[request.owner] : undefined;
        const creator =
          personToken ?? (tokenPath === undefined ? undefined : readFileSync(tokenPath, 'utf8').trim());
        ({ text } = await callWithToken(method, url, creator ?? token, body));
      } catch (error) {
        throw new ProviderConfigError(
          // The cause is where an undici failure keeps its reason ("fetch failed" on its own says
          // nothing). It reaches the host log, not the container: this is a ProviderConfigError, and
          // the broker answers the pusher with whatever it carries.
          `${(error as Error).message}${describeCause(error)}; this needs the pull_requests: write permission on both the app and this installation`,
        );
      }

      if (request.action === 'merge') {
        // The merge answers with a sha and a message, not the pull request, so read it back for the
        // canonical URL — and to report whether GitHub actually merged it.
        const merged = JSON.parse(text) as { merged?: unknown };
        if (merged.merged !== true) {
          throw new ProviderConfigError('GitHub did not merge the pull request');
        }
        const { text: after } = await callWithToken('GET', `${collection}/${request.number}`, token);
        return readPullRequest(after);
      }

      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      const payload = (parsed ?? {}) as { number?: unknown; html_url?: unknown; state?: unknown; merged?: unknown };
      if (typeof payload.number !== 'number' || typeof payload.html_url !== 'string') {
        throw new ProviderConfigError('GitHub did not answer with a pull request');
      }
      return {
        number: payload.number,
        url: payload.html_url,
        state: typeof payload.state === 'string' ? payload.state : undefined,
        merged: payload.merged === true,
      };
    },

  };
}
