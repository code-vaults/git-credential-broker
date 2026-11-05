import { ProviderConfigError } from 'gcb-core';
import type { FetchLike, FetchResponseLike } from 'gcb-core';

/** How long one visibility check may take, including the body. */
const CHECK_TIMEOUT_MS = 10_000;

/** Options shared by the unauthenticated repository checks. */
export interface RepositoryCheckOptions {
  /** GitHub API version header; defaults to 2022-11-28. */
  readonly apiVersion?: string;
  /** Whole-request deadline, including the body; defaults to 10 seconds. */
  readonly timeoutMs?: number;
  /** Name used in the timeout message. */
  readonly label?: string;
}

/**
 * Run one unauthenticated repository request with a deadline and no redirects.
 *
 * @param fetchImpl - the transport for this host's proxy choice.
 * @param apiBaseUrl - the API base, without a trailing path.
 * @param repository - `owner/name`.
 * @param options - API version, deadline and a label for the timeout message.
 * @param handle - reads the response while the deadline is still active.
 * @returns whatever the handler returns.
 */
export async function withRepositoryResponse<T>(
  fetchImpl: FetchLike,
  apiBaseUrl: string,
  repository: string,
  options: RepositoryCheckOptions,
  handle: (response: FetchResponseLike) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CHECK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${apiBaseUrl}/repos/${repository}`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': options.apiVersion ?? '2022-11-28',
        'user-agent': 'gcb',
      },
      signal: controller.signal,
      redirect: 'error',
    });
    return await handle(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderConfigError(
        `GitHub timed out during the ${options.label ?? 'repository'} check; retry later`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Check a repository with no credential; only a confirmed public result is true. */
export async function isPublicRepository(
  fetchImpl: FetchLike,
  apiBaseUrl: string,
  repository: string,
  apiVersion = '2022-11-28',
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<boolean> {
  return withRepositoryResponse(
    fetchImpl,
    apiBaseUrl,
    repository,
    { apiVersion, timeoutMs, label: 'public-repository' },
    async (response) => {
      if (response.status === 403 || response.status === 429) {
        const exhausted =
          response.status === 429 ||
          response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.get('retry-after') !== null;
        throw new ProviderConfigError(
          exhausted
            ? 'GitHub rate-limited the unauthenticated public-repository check; retry later or allowlist the repository'
            : 'GitHub refused the unauthenticated public-repository check; check the access policy or allowlist the repository',
        );
      }
      if (!response.ok) return false;
      try {
        const body = JSON.parse(await response.text()) as { private?: unknown } | null;
        return body?.private === false;
      } catch {
        return false;
      }
    },
  );
}
