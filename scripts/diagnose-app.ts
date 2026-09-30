#!/usr/bin/env node
/**
 * Diagnose a GitHub App's installation and repository scoping.
 *
 * The broker deliberately answers the container with a generic "could not mint a credential",
 * so the real reason only exists host-side. This script asks GitHub directly and prints what
 * the app can actually see, which is what tells apart the two causes of
 *
 *   422 "There is at least one repository that does not exist or is not accessible to the
 *   parent installation"
 *
 * — the repository was never created, or the installation was granted "only select
 * repositories" and this one is not on that list. The message is identical for both.
 *
 * It never prints a key or a token.
 *
 * Usage:
 *   node scripts/diagnose-app.ts --config /volume1/docker/git-cred-broker/config.json
 */
import { readFileSync } from 'node:fs';

import { loadConfig } from '../src/config.ts';
import { nextLink, signAppJwt } from '../src/providers/github-app.ts';
import type { GithubAppHostConfig } from '../src/types.ts';

/** One installation, as far as this script cares. */
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

/**
 * Parse `--config <path>`.
 *
 * @param argv - arguments after the script name.
 * @returns the config path.
 */
function parseConfigArg(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--config') return argv[index + 1];
    if (argument?.startsWith('--config=')) return argument.slice('--config='.length);
  }
  return undefined;
}

const configPath = parseConfigArg(process.argv.slice(2));
if (!configPath) {
  process.stderr.write('usage: node scripts/diagnose-app.ts --config <broker config.json>\n');
  process.exit(2);
}

const config = loadConfig(configPath);
const entry = Object.entries(config.hosts).find(([, block]) => block.provider === 'github-app');
if (!entry) {
  process.stderr.write('diagnose: no github-app host in that configuration\n');
  process.exit(2);
}
const [host, block] = entry as [string, GithubAppHostConfig];
if (!block.privateKeyPath) {
  process.stderr.write('diagnose: this host uses privateKeyPem; point the script at a config with privateKeyPath\n');
  process.exit(2);
}

const pem = readFileSync(block.privateKeyPath, 'utf8');
const issuer = block.clientId ?? block.appId;
if (issuer === undefined) {
  process.stderr.write('diagnose: the host block has neither clientId nor appId\n');
  process.exit(2);
}
const api = block.apiBaseUrl ?? 'https://api.github.com';

/**
 * Call the API authenticated as the app.
 *
 * @param path - path below the API root.
 * @returns the parsed body and the Link header.
 * @throws {Error} for a non-2xx response.
 */
async function asApp(path: string): Promise<{ json: unknown; link: string | null }> {
  const jwt = signAppJwt({ privateKeyPem: pem, iss: issuer as string | number, nowMs: Date.now() });
  const response = await fetch(`${api}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt}`,
      'x-github-api-version': block.apiVersion ?? '2022-11-28',
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
      json && typeof json === 'object' && 'message' in json
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
 * @throws {Error} for a non-2xx response.
 */
async function asInstallation(installationId: number, path: string): Promise<unknown> {
  const jwt = signAppJwt({ privateKeyPem: pem, iss: issuer as string | number, nowMs: Date.now() });
  const minted = await fetch(`${api}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${jwt}`,
      'x-github-api-version': block.apiVersion ?? '2022-11-28',
      'user-agent': 'git-credential-broker-diagnose',
    },
  });
  const mintedText = await minted.text();
  if (!minted.ok) throw new Error(`token request for installation ${installationId} -> ${minted.status}: ${mintedText.slice(0, 200)}`);
  const token = (JSON.parse(mintedText) as { token?: string }).token;
  if (!token) throw new Error(`installation ${installationId} returned no token`);

  const response = await fetch(`${api}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': block.apiVersion ?? '2022-11-28',
      'user-agent': 'git-credential-broker-diagnose',
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as unknown;
}

const app = (await asApp('/app')).json as { id?: number; slug?: string; permissions?: Record<string, string> };
process.stdout.write(`app            : ${app.slug ?? '?'} (id ${app.id ?? '?'})\n`);
process.stdout.write(`app permissions: ${JSON.stringify(app.permissions ?? {})}\n`);
process.stdout.write(`config host    : ${host}, allow ${JSON.stringify(block.allow)}\n\n`);

const installations: Installation[] = [];
let page: string | null = '/app/installations?per_page=100';
for (let index = 0; index < 10 && page; index += 1) {
  const result = await asApp(page);
  if (Array.isArray(result.json)) installations.push(...(result.json as Installation[]));
  page = nextLink(result.link);
}

if (installations.length === 0) {
  process.stdout.write('installations  : none\n');
  process.stdout.write('\nverdict: the app is not installed anywhere. Install it on the account that owns the\n');
  process.stdout.write('         repositories: https://github.com/apps/<slug>/installations/new\n');
  process.exit(1);
}

/** Repositories each installation can reach, keyed by installation id. */
const reachable = new Map<number, string[]>();

for (const installation of installations) {
  const account = installation.account?.login ?? '?';
  const selection = installation.repository_selection ?? '?';
  process.stdout.write(`installation ${installation.id}\n`);
  process.stdout.write(`  account            : ${account} (${installation.account?.type ?? '?'})\n`);
  process.stdout.write(`  repository access  : ${selection}\n`);
  process.stdout.write(`  permissions        : ${JSON.stringify(installation.permissions ?? {})}\n`);

  // Enumerate even when the selection is "all". "All" means every repository that *exists*;
  // naming one that does not exist still fails with the same 422, so without this list a
  // repository that was never created looks exactly like one that is merely not selected.
  const listed = (await asInstallation(installation.id, '/installation/repositories?per_page=100')) as {
    repositories?: Repository[];
  };
  const names = (listed.repositories ?? []).map((repo) => repo.full_name ?? '?');
  reachable.set(installation.id, names);
  process.stdout.write(
    `  repositories (${names.length}${names.length >= 100 ? '+' : ''}): ${names.slice(0, 20).join(', ') || '(none)'}${names.length > 20 ? ', …' : ''}\n`,
  );
}

process.stdout.write('\nverdict:\n');
let problems = 0;
for (const entry of block.allow) {
  const [owner, repoPattern] = entry.split('/');
  const matching = installations.filter(
    (installation) => installation.account?.login?.toLowerCase() === owner?.toLowerCase(),
  );
  if (matching.length === 0) {
    process.stdout.write(`  ${entry}: no installation on account "${owner}"\n`);
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
  process.stdout.write(
    `  ${entry}: ${visible ? 'reachable' : 'NOT in the repositories this installation can see'}\n`,
  );
  if (!visible) problems += 1;
}

if (problems > 0) {
  process.stdout.write(
    '\nA repository that is not in the list above is either not created yet, or the installation\n' +
      'was granted "Only select repositories" and this one is not on that list — GitHub returns\n' +
      'the same 422 for both. To grant access:\n' +
      '  https://github.com/organizations/<owner>/settings/installations   (then Configure)\n',
  );
}
process.exit(problems > 0 ? 1 : 0);
