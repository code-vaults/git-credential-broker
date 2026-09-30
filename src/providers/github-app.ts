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
import { readFileSync } from 'node:fs';

import type { Credential, FetchLike, FetchResponseLike, GithubAppHostConfig, Provider } from '../types.ts';

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

  /** owner login (lowercased) -> installation */
  const installations = new Map<string, CachedInstallation>();
  /** owner/repo -> minted credential */
  const tokens = new Map<string, Credential>();
  /** Cached result of the one-time permission pre-flight. */
  let permissionsChecked: Promise<void> | null = null;

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
   * Confirm the app is actually granted every permission the token request will ask for.
   *
   * Requesting a permission the app was never granted makes GitHub answer 422, which would
   * otherwise surface at push time as an opaque "could not mint a credential". GitHub App
   * permissions are configured in the UI and easy to forget, so this turns the failure into a
   * precise message naming the missing permission.
   *
   * Runs once per process. A failed check is not cached, so an operator who fixes the app
   * settings does not have to restart the broker.
   *
   * @returns resolves when the configured permissions are a subset of the granted ones.
   * @throws {Error} naming each permission that is missing or granted at a lower level.
   */
  function ensurePermissions(): Promise<void> {
    if (!checkPermissions) return Promise.resolve();
    if (!permissionsChecked) {
      permissionsChecked = (async (): Promise<void> => {
        const { json } = await call('GET', `${api}/app`);
        const granted = (json as { permissions?: Record<string, string> } | null)?.permissions ?? {};
        const problems: string[] = [];
        for (const [name, wanted] of Object.entries(permissions)) {
          const have = granted[name];
          if (!have) {
            problems.push(`${name}: requested "${wanted}" but the app is not granted this permission at all`);
            continue;
          }
          if ((ACCESS_LEVELS[wanted] ?? 0) > (ACCESS_LEVELS[have] ?? 0)) {
            problems.push(`${name}: requested "${wanted}" but the app only has "${have}"`);
          }
        }
        if (problems.length > 0) {
          throw new Error(
            `the app cannot grant the configured permissions for ${host} (${problems.join('; ')}); ` +
              'grant them in the GitHub App settings, or lower `permissions` in the broker config, ' +
              'or set "verifyAppPermissions": false to skip this check',
          );
        }
      })().catch((error: unknown) => {
        permissionsChecked = null;
        throw error;
      });
    }
    return permissionsChecked;
  }

  return {
    name: 'github-app',

    async getCredential(request): Promise<Credential> {
      const cached = tokens.get(request.full);
      if (cached && cached.expiresAt - now() > skewSeconds * 1000) {
        return { ...cached, cached: true };
      }

      await ensurePermissions();
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
  };
}
