/**
 * Let a branch name say *which* repository it is on, by naming a configured remote.
 *
 * `--head feat/x` is a branch in the repository `--repo` names. For a pull request from your fork into an
 * upstream, one of the two has to name the other repository, and the honest way to say it is the remote
 * name you already push to: `--head origin:feat/x --base upstream:main`. A hand-typed `owner/name` is a
 * string that can be wrong in a way that looks right; a remote name is one git already knows, and a typo
 * gets you the list of the ones that exist.
 *
 * Resolved here rather than on the host, because this process runs in the checkout: the wire carries the
 * answer, so the host side needs no git and no repository.
 */
import { execFileSync } from 'node:child_process';

/** What a remote's URL says: the owner and the repository, for a GitHub-shaped URL. */
export interface RemoteRepo {
  readonly owner: string;
  readonly repo: string;
}

/**
 * Run a git command in a directory, and answer with everything it said.
 *
 * Everything, not the first line: `git remote get-url` answers with one, and `git remote` with all of
 * them, and a helper that quietly dropped the rest would report one remote for a checkout with two.
 *
 * @param args - the arguments, without `git`.
 * @param cwd - where to run it.
 * @returns the output, or undefined when git refused.
 */
function git(args: readonly string[], cwd: string): string | undefined {
  try {
    const out = execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const trimmed = out.replace(/\s+$/, '');
    return trimmed === '' ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

/**
 * The remotes this checkout knows, in the order git lists them.
 *
 * @param cwd - the directory to ask.
 * @returns the names, possibly empty.
 */
export function listRemotes(cwd: string): string[] {
  return (git(['remote'], cwd) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * What repository a remote points at.
 *
 * HTTPS and SSH spell the same thing differently, and both end in `owner/repo`, optionally with a `.git`.
 *
 * @param name - the remote name.
 * @param cwd - the directory to ask.
 * @returns the owner and repository, or undefined when there is no such remote or the URL is not one.
 */
export function remoteRepo(name: string, cwd: string): RemoteRepo | undefined {
  const url = git(['remote', 'get-url', name], cwd);
  if (url === undefined) return undefined;
  // Two spellings, one shape: `host:owner/repo` (ssh) and `host/owner/repo` (https). Either way the host
  // is the first part and the repository is what is left, so anything else — a local path, a self-hosted
  // layout with a prefix — is refused rather than read as something it is not.
  const cleaned = url.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  const withoutHost =
    cleaned.includes(':') && !(cleaned.split(':')[0] ?? '').includes('/')
      ? cleaned.slice(cleaned.indexOf(':') + 1)
      : cleaned.split('/').slice(1).join('/');
  const path = withoutHost.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const [owner, repo, ...rest] = path.split('/').filter((part) => part !== '');
  if (owner === undefined || repo === undefined || rest.length > 0) return undefined;
  return { owner, repo };
}

/**
 * Turn `remote:branch` into `owner:branch`, and leave a plain branch alone.
 *
 * @param value - what the operator wrote.
 * @param cwd - the directory to resolve remotes in.
 * @returns the value to send.
 * @throws {Error} when the prefix is not a remote this checkout knows, naming the ones it does.
 */
export function qualifiedBranch(value: string, cwd: string): string {
  const colon = value.indexOf(':');
  if (colon < 0) return value;
  const name = value.slice(0, colon);
  const branch = value.slice(colon + 1);
  const found = remoteRepo(name, cwd);
  if (found === undefined) {
    const known = listRemotes(cwd);
    throw new Error(
      `no remote named ${JSON.stringify(name)} here, so ${JSON.stringify(value)} cannot be resolved` +
        (known.length > 0 ? `; this checkout has: ${known.join(', ')}` : '; this checkout has no remotes'),
    );
  }
  return `${found.owner}:${branch}`;
}
