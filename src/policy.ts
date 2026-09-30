/**
 * Authorization policy: the only place that decides whether a host + repository pair may
 * receive a credential.
 *
 * Design rules (see the design review, findings P0-1 and P2-3):
 *  - default deny: an unknown host or an unlisted repository never yields a credential;
 *  - repository paths are normalized (drop leading/trailing slashes, drop a trailing
 *    `.git`, lowercase) before matching, because GitHub owner/repo names are
 *    case-insensitive;
 *  - matching is exact per path segment, never a prefix match, so an allowlist entry for
 *    `acme/widget` can never authorize `acme/widget-evil`;
 *  - a wildcard is allowed only as a whole segment, never inside one, so a malformed entry
 *    matches nothing and therefore fails closed.
 */
import type { BrokerConfig, HostConfig, RepoRef } from './types.ts';

/** One `owner` or `repo` segment: starts alphanumeric, then letters/digits/._- */
const SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** A whole repository path as git would report it, before normalization. */
const REPO_PATH_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)$/;

/** A segment that is nothing but dots — `.`, `..`, `...` — never a real repository name. */
const ALL_DOTS_RE = /^\.+$/;

/** The wildcard that may stand in for one whole segment. */
const WILDCARD = '*';

/** One parsed allowlist entry. */
export interface AllowEntry {
  readonly owner: string;
  readonly repo: string;
}

/**
 * Normalize the `path=` value git hands to a credential helper into an `owner/repo` pair.
 *
 * @param rawPath - the raw `path` field, e.g. `acme/widget.git`.
 * @returns the normalized reference, or null when the value is missing, has more than two
 *   segments, is made of dots, or contains characters we refuse to guess about.
 */
export function normalizeRepoPath(rawPath: unknown): RepoRef | null {
  if (typeof rawPath !== 'string') return null;
  let candidate = rawPath.trim();
  if (!candidate) return null;

  const hash = candidate.indexOf('#');
  if (hash >= 0) candidate = candidate.slice(0, hash);
  const query = candidate.indexOf('?');
  if (query >= 0) candidate = candidate.slice(0, query);

  while (candidate.startsWith('/')) candidate = candidate.slice(1);
  while (candidate.endsWith('/')) candidate = candidate.slice(0, -1);
  if (candidate.toLowerCase().endsWith('.git')) candidate = candidate.slice(0, -4);
  if (!candidate) return null;

  const match = REPO_PATH_RE.exec(candidate);
  if (!match) return null;
  const rawOwner = match[1];
  const rawRepo = match[2];
  if (rawOwner === undefined || rawRepo === undefined) return null;

  // `acme/..` satisfies the segment pattern above but is a traversal attempt, not a name.
  if (ALL_DOTS_RE.test(rawOwner) || ALL_DOTS_RE.test(rawRepo)) return null;

  const owner = rawOwner.toLowerCase();
  const repo = rawRepo.toLowerCase();
  return { owner, repo, full: `${owner}/${repo}` };
}

/**
 * Parse one allowlist entry: exactly two segments, each either an identifier or a
 * whole-segment wildcard.
 *
 * @param entry - the raw entry from configuration.
 * @returns the parsed entry, or null when it is malformed (which matches nothing).
 */
export function parseAllowEntry(entry: unknown): AllowEntry | null {
  if (typeof entry !== 'string') return null;
  const parts = entry.trim().toLowerCase().split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  if (owner === undefined || repo === undefined) return null;
  const valid = (segment: string): boolean => segment === WILDCARD || SEGMENT_RE.test(segment);
  if (!valid(owner) || !valid(repo)) return null;
  return { owner, repo };
}

/**
 * Whether a normalized repository is covered by an allowlist.
 *
 * @param allowList - configured allow entries.
 * @param full - a normalized `owner/repo` string.
 * @returns true only for an exact segment-wise match.
 */
export function repoAllowed(allowList: unknown, full: string): boolean {
  if (typeof full !== 'string' || !Array.isArray(allowList)) return false;
  const slash = full.indexOf('/');
  if (slash <= 0) return false;
  const owner = full.slice(0, slash);
  const repo = full.slice(slash + 1);

  for (const raw of allowList) {
    const entry = parseAllowEntry(raw);
    if (!entry) continue;
    const ownerMatches = entry.owner === WILDCARD || entry.owner === owner;
    const repoMatches = entry.repo === WILDCARD || entry.repo === repo;
    if (ownerMatches && repoMatches) return true;
  }
  return false;
}

/** A host block together with the key it was configured under. */
export type ResolvedHostConfig = HostConfig & { readonly host: string };

/**
 * Look up the configuration block for a host as git reports it.
 *
 * git sends `host=github.com` for the default port and `host=127.0.0.1:8080` otherwise, so
 * the comparison is on the literal string, case-insensitively.
 *
 * @param config - a validated broker config.
 * @param host - the `host` field from the credential request.
 * @returns the matching block, or null (default deny).
 */
export function hostConfig(config: BrokerConfig, host: unknown): ResolvedHostConfig | null {
  if (typeof host !== 'string' || !host) return null;
  const wanted = host.toLowerCase();
  for (const [configuredHost, block] of Object.entries(config.hosts)) {
    if (configuredHost.toLowerCase() === wanted) return { host: configuredHost, ...block };
  }
  return null;
}
