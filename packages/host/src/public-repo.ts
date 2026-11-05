import { ProviderConfigError } from 'gcb-core';
import type { FetchLike } from 'gcb-core';

/** Check a repository with no credential; only a confirmed public result is true. */
export async function isPublicRepository(
  fetchImpl: FetchLike,
  apiBaseUrl: string,
  repository: string,
  apiVersion = '2022-11-28',
): Promise<boolean> {
  const response = await fetchImpl(`${apiBaseUrl}/repos/${repository}`, {
    method: 'GET',
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': apiVersion,
      'user-agent': 'gcb',
    },
  });
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
}
