import { ProviderConfigError } from 'gcb-core'
import type { FetchLike, FetchResponseLike } from 'gcb-core'

/** How long one visibility check may take, including the body. */
const CHECK_TIMEOUT_MS = 10_000

/** Options shared by the unauthenticated repository checks. */
export interface RepositoryCheckOptions {
  /** GitHub API version header; defaults to 2022-11-28. */
  readonly apiVersion?: string
  /** Whole-request deadline, including the body; defaults to 10 seconds. */
  readonly timeoutMs?: number
  /** Name used in the timeout and rate-limit messages. */
  readonly label?: string
  /** Whether the request carried an app token; changes only the refusal wording. */
  readonly authenticated?: boolean
  /** Caller-owned deadline shared with the stages around this request. */
  readonly signal?: AbortSignal
}

/**
 * Run one repository request with a deadline and no redirects.
 *
 * @param fetchImpl - The transport for this host's proxy choice.
 * @param apiBaseUrl - The API base, without a trailing path.
 * @param repository - `owner/name`.
 * @param options - API version, deadline and a label for the timeout message.
 * @param handle - Reads the response while the deadline is still active.
 * @returns Whatever the handler returns.
 */
export async function withRepositoryResponse<T>(
  fetchImpl: FetchLike,
  apiBaseUrl: string,
  repository: string,
  options: RepositoryCheckOptions,
  handle: (response: FetchResponseLike) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CHECK_TIMEOUT_MS)
  const signal =
    options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal])
  try {
    const response = await fetchImpl(`${apiBaseUrl}/repos/${repository}`, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': options.apiVersion ?? '2022-11-28',
        'user-agent': 'gcb',
      },
      signal,
      redirect: 'error',
    })
    if (response.status === 403 || response.status === 429) {
      const exhausted =
        response.status === 429 ||
        response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.get('retry-after') !== null
      const label = options.label ?? 'repository'
      throw new ProviderConfigError(
        exhausted
          ? `GitHub rate-limited the ${options.authenticated === true ? 'authenticated' : 'unauthenticated'} ${label} check; retry later or allowlist the repository`
          : `GitHub refused the ${options.authenticated === true ? 'authenticated' : 'unauthenticated'} ${label} check; check the access policy or allowlist the repository`,
      )
    }
    return await handle(response)
  } catch (error) {
    if (signal.aborted) {
      throw new ProviderConfigError(
        `GitHub timed out during the ${options.label ?? 'repository'} check; retry later`,
      )
    }
    throw error
  } finally {
    clearTimeout(timer)
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
    async response => {
      if (!response.ok) {
        return false
      }
      const text = await response.text()
      try {
        const body = JSON.parse(text) as { private?: unknown } | null
        return body?.private === false
      } catch {
        return false
      }
    },
  )
}

/**
 * Check whether a public repository is a fork of another, with no credential.
 *
 * @param fetchImpl - The transport for this host's proxy choice.
 * @param apiBaseUrl - The API base, without a trailing path.
 * @param repository - The possible fork, `owner/name`.
 * @param parent - The possible parent/source, `owner/name`.
 * @param apiVersion - GitHub API version header.
 * @param timeoutMs - Whole-request deadline.
 * @returns True only when GitHub confirms the fork relationship.
 */
export async function isForkOfRepository(
  fetchImpl: FetchLike,
  apiBaseUrl: string,
  repository: string,
  parent: string,
  apiVersion = '2022-11-28',
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<boolean> {
  return withRepositoryResponse(
    fetchImpl,
    apiBaseUrl,
    repository,
    { apiVersion, timeoutMs, label: 'fork' },
    async response => {
      if (!response.ok) {
        return false
      }
      const text = await response.text()
      try {
        const body = JSON.parse(text) as {
          fork?: unknown
          parent?: { full_name?: unknown } | null
          source?: { full_name?: unknown } | null
        } | null
        if (body?.fork !== true) {
          return false
        }
        const names = [body.parent?.full_name, body.source?.full_name]
          .filter((name): name is string => typeof name === 'string')
          .map(name => name.toLowerCase())
        return names.includes(parent.toLowerCase())
      } catch {
        return false
      }
    },
  )
}
