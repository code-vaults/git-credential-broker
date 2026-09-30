/**
 * `diagnose` — explain why the broker could not mint a token.
 *
 * The broker deliberately answers the pushing side with a generic message, because provider
 * errors can embed API responses. This asks GitHub directly and prints what the app can
 * actually see, which is what separates the two causes of
 *
 *   422 "There is at least one repository that does not exist or is not accessible to the
 *   parent installation"
 *
 * — the repository was never created, or the installation was granted "only select
 * repositories" and this one is not on that list. The message is identical for both.
 *
 * It never prints a key or a token.
 */
import { readFileSync } from 'node:fs';

import { assertKeysReadable, loadConfig, resolveConfigPath } from '../config.ts';
import { nextLink, signAppJwt } from '../providers/github-app.ts';
import type { GithubAppHostConfig } from '../types.ts';
import { fail, parseArgs, say, warn } from './support.ts';

/** One installation, as far as this command cares. */
interface Installation {
  readonly id: number;
  readonly account?: { readonly login?: string; readonly type?: string };
  readonly repository_selection?: string;
  readonly permissions?: Record<string, string>;
}

/** One accessible repository. */
interface Repository {
  readonly full_name?: string;
  readonly private?: boolean;
}

/** Usage text for `diagnose`. */
export const DIAGNOSE_USAGE = `Usage: git-credential-broker diagnose [options]

Ask GitHub what this app can actually see: identity, permissions, installations and the
repositories each installation can reach. Never prints a key or a token.

  --config <path>  The broker configuration to inspect (default: $GIT_BROKER_CONFIG, else ./broker.config.json)
  --host <host>    Which host block to inspect (default: the first github-app one)
  -h, --help       Show this help
`;

/**
 * Run the `diagnose` command.
 *
 * @param argv - arguments after the command name.
 * @returns the process exit code: 0 everything reachable, 1 something is not.
 */
export async function runDiagnose(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv, { booleans: ['help'] });
  if (args.has('help') || args.has('h')) {
    say(DIAGNOSE_USAGE);
    return 0;
  }

  const configPath = resolveConfigPath(args.value('config'));

  const config = loadConfig(configPath);
  // Before reading the key: a configuration written for the sidecar records a path that exists only
  // inside that container, and running this on the host then fails with a bare ENOENT about a path
  // that looks like a mistake in the key rather than in where the command was run.
  assertKeysReadable(config);
  const wanted = args.value('host');
  const entry = Object.entries(config.hosts).find(
    ([host, block]) => block.provider === 'github-app' && (wanted ? host === wanted : true),
  );
  if (!entry) fail(`no github-app host${wanted ? ` named ${wanted}` : ''} in ${configPath}`);
  const [host, block] = entry as [string, GithubAppHostConfig];

  if (!block.privateKeyPath) {
    fail('this host uses privateKeyPem; point the command at a config that references a key file');
  }
  const pem = readFileSync(block.privateKeyPath, 'utf8');
  const issuer = block.clientId ?? block.appId;
  if (issuer === undefined) fail('the host block has neither clientId nor appId');
  const api = block.apiBaseUrl ?? 'https://api.github.com';
  const apiVersion = block.apiVersion ?? '2022-11-28';

  /**
   * Call the API authenticated as the app.
   *
   * @param path - path below the API root.
   * @returns the parsed body and the Link header.
   */
  async function asApp(path: string): Promise<{ json: unknown; link: string | null }> {
    const jwt = signAppJwt({ privateKeyPem: pem, iss: issuer as string | number, nowMs: Date.now() });
    const response = await fetch(`${api}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'x-github-api-version': apiVersion,
        'user-agent': 'git-credential-broker-diagnose',
      },
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
      throw new Error(`${path} -> ${response.status}: ${message}`);
    }
    return { json, link: response.headers.get('link') };
  }

  /**
   * Call the API authenticated as one installation.
   *
   * @param installationId - the installation to act as.
   * @param path - path below the API root.
   * @returns the parsed body.
   */
  async function asInstallation(installationId: number, path: string): Promise<unknown> {
    const jwt = signAppJwt({ privateKeyPem: pem, iss: issuer as string | number, nowMs: Date.now() });
    const minted = await fetch(`${api}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'x-github-api-version': apiVersion,
        'user-agent': 'git-credential-broker-diagnose',
      },
    });
    const mintedText = await minted.text();
    if (!minted.ok) {
      throw new Error(`token request for installation ${installationId} -> ${minted.status}: ${mintedText.slice(0, 200)}`);
    }
    const token = (JSON.parse(mintedText) as { token?: string }).token;
    if (!token) throw new Error(`installation ${installationId} returned no token`);

    const response = await fetch(`${api}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': apiVersion,
        'user-agent': 'git-credential-broker-diagnose',
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text) as unknown;
  }

  const app = (await asApp('/app')).json as { id?: number; slug?: string; permissions?: Record<string, string> };
  say(`app            : ${app.slug ?? '?'} (id ${app.id ?? '?'})`);
  say(`app permissions: ${JSON.stringify(app.permissions ?? {})}`);
  say(`config host    : ${host}, allow ${JSON.stringify(block.allow)}`);
  say('');

  const installations: Installation[] = [];
  let page: string | null = '/app/installations?per_page=100';
  for (let index = 0; index < 10 && page; index += 1) {
    const result = await asApp(page);
    if (Array.isArray(result.json)) installations.push(...(result.json as Installation[]));
    page = nextLink(result.link);
  }

  if (installations.length === 0) {
    say('installations  : none');
    say('');
    say('The app is not installed anywhere. Install it on the account that owns the repositories.');
    return 1;
  }

  /** Repositories each installation can reach. */
  const reachable = new Map<number, string[]>();

  for (const installation of installations) {
    say(`installation ${installation.id}`);
    say(`  account            : ${installation.account?.login ?? '?'} (${installation.account?.type ?? '?'})`);
    say(`  repository access  : ${installation.repository_selection ?? '?'}`);
    say(`  permissions        : ${JSON.stringify(installation.permissions ?? {})}`);

    // Enumerate even when the selection is "all". "All" means every repository that *exists*;
    // naming one that does not exist still fails with the same 422, so without this list a
    // repository that was never created looks exactly like one that is merely not selected.
    const listed = (await asInstallation(installation.id, '/installation/repositories?per_page=100')) as {
      repositories?: Repository[];
    };
    const names = (listed.repositories ?? []).map((repo) => repo.full_name ?? '?');
    reachable.set(installation.id, names);
    const shown = names.slice(0, 20).join(', ');
    say(
      `  repositories (${names.length}${names.length >= 100 ? '+' : ''}): ${shown || '(none)'}${names.length > 20 ? ', …' : ''}`,
    );
  }

  say('');
  say('verdict:');
  let problems = 0;
  for (const allowEntry of block.allow) {
    const [owner, repoPattern] = allowEntry.split('/');
    const matching = installations.filter(
      (installation) => installation.account?.login?.toLowerCase() === owner?.toLowerCase(),
    );
    if (matching.length === 0) {
      say(`  ${allowEntry}: no installation on account "${owner}"`);
      problems += 1;
      continue;
    }
    const visible = matching.some((installation) => {
      const known = reachable.get(installation.id) ?? [];
      if (repoPattern === '*') {
        return known.some((name) => name.toLowerCase().startsWith(`${owner?.toLowerCase()}/`));
      }
      return known.some((name) => name.toLowerCase() === `${owner?.toLowerCase()}/${repoPattern?.toLowerCase()}`);
    });
    say(`  ${allowEntry}: ${visible ? 'reachable' : 'NOT in the repositories this installation can see'}`);
    if (!visible) problems += 1;
  }

  if (problems > 0) {
    warn('');
    warn('A repository that is not listed above either does not exist yet, or the installation was');
    warn('granted "Only select repositories" and this one is not on that list — GitHub returns the');
    warn('same 422 for both. To grant access: organisation settings -> GitHub Apps -> Configure.');
  }
  return problems > 0 ? 1 : 0;
}
