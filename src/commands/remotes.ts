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
export function remoteRepo(name: string, cwd: string, push = false): RemoteRepo | undefined {
  // `--push` for a head: git lets a remote fetch from one place and push to another, and the branch a
  // pull request comes from lives where it was pushed. The base asks the other question.
  const url = git(['remote', 'get-url', ...(push ? ['--push'] : []), name], cwd);
  if (url === undefined) return undefined;

  // A URL has an authority and then a path; the scp form has a host and then one. Anything else — a local
  // path, a `file:` URL, a host with no dot — is refused rather than read as an owner that happens to be a
  // port number or a directory name.
  let path: string | undefined;
  if (/^[a-z+]+:\/\//i.test(url)) {
    const rest = url.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]*@/, '');
    const slash = rest.indexOf('/');
    const authority = slash < 0 ? '' : rest.slice(0, slash);
    const host = authority.split(':')[0] ?? '';
    if (slash >= 0 && host.includes('.')) path = rest.slice(slash + 1);
  } else {
    const scp = /^(?:[^@/]+@)?([^/:]+\.[^/:]+):(.+)$/.exec(url);
    if (scp !== null && scp[2] !== undefined) path = scp[2];
  }
  if (path === undefined) return undefined;

  const cleaned = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const [owner, repo, ...rest] = cleaned.split('/').filter((part) => part !== '');
  if (owner === undefined || repo === undefined || rest.length > 0) return undefined;
  return { owner, repo };
}

/**
 * The URL a remote points at, for saying what was wrong with it.
 *
 * @param name - the remote name.
 * @param cwd - the directory to ask.
 * @returns the URL, or undefined when there is no such remote.
 */
export function remoteUrl(name: string, cwd: string): string | undefined {
  return git(['remote', 'get-url', name], cwd);
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
  const found = remoteRepo(name, cwd, true);
  if (found === undefined) {
    const known = listRemotes(cwd);
    const url = remoteUrl(name, cwd);
    if (url !== undefined) {
      throw new Error(
        `remote ${JSON.stringify(name)} points at ${url}, which does not name an owner and a repository`,
      );
    }
    throw new Error(
      `no remote named ${JSON.stringify(name)} here, so ${JSON.stringify(value)} cannot be resolved` +
        (known.length > 0 ? `; this checkout has: ${known.join(', ')}` : '; this checkout has no remotes'),
    );
  }
  return `${found.owner}:${branch}`;
}

/**
 * The branch a `--base` means, given the repository the pull request lands in.
 *
 * `--base upstream:main` names the remote for the check and the branch for the wire: a base is a branch of
 * `--repo`, and `owner:branch` is not a branch name anywhere. A remote pointing at a different repository
 * is a mistake worth catching here rather than letting GitHub answer confusingly.
 *
 * @param raw - what the operator wrote.
 * @param repo - the repository `--repo` names, as `owner/name`.
 * @param cwd - the directory to resolve remotes in.
 * @returns the branch to send.
 * @throws {Error} when the remote points at a repository other than `repo`.
 */
export function baseBranchFor(raw: string, repo: string, cwd: string): string {
  const colon = raw.indexOf(':');
  if (colon < 0) return raw;
  const name = raw.slice(0, colon);
  const found = remoteRepo(name, cwd, true);
  if (found === undefined) {
    // Says what is wrong with the remote rather than pretending the base is the problem.
    throw new Error(`--base names ${JSON.stringify(name)}, which is not a remote this checkout can read`);
  }
  if (`${found.owner}/${found.repo}`.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(
      `--base names a remote pointing at ${found.owner}/${found.repo}, but --repo is ${repo}: the base is a branch of the repository the pull request lands in`,
    );
  }
  return raw.slice(colon + 1);
}
