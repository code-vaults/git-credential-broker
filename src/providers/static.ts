/**
 * Static credential provider: one fixed username/password pair for one host.
 *
 * This exists for two reasons. First, it makes the whole broker testable and provable end
 * to end without registering a GitHub App or reaching the internet. Second, it is the
 * honest escape hatch for hosts that only offer long-lived tokens (self-hosted
 * Gitea/GitLab, a colleague's box): the token still lives only on the broker side and still
 * never crosses the socket in the other direction.
 *
 * The password is read at startup and kept in memory; it is never written to the audit log,
 * never returned in an error message, and never echoed by the helper.
 */
import { readFileSync } from 'node:fs';

import type { Credential, Provider, StaticHostConfig } from '../types.ts';

/** Options for {@link createStaticProvider}. */
export interface StaticProviderOptions {
  /** The host this provider serves. */
  readonly host: string;
  readonly cfg: StaticHostConfig;
  /** Clock, injectable for tests. */
  readonly now?: () => number;
}

/**
 * Build a static provider.
 *
 * @param options - provider options.
 * @returns the provider.
 * @throws {Error} when no password source is configured (fail fast).
 */
export function createStaticProvider(options: StaticProviderOptions): Provider {
  const { host, cfg, now = () => Date.now() } = options;

  let password: string | null = typeof cfg.password === 'string' && cfg.password ? cfg.password : null;
  if (!password && cfg.passwordPath) password = readFileSync(cfg.passwordPath, 'utf8').trim();
  if (!password && cfg.passwordEnv) password = process.env[cfg.passwordEnv] ?? null;
  if (!password) {
    throw new Error(
      `static provider for ${host}: no secret configured (set one of password, passwordPath, passwordEnv)`,
    );
  }

  const username = cfg.username ?? 'x-access-token';
  const ttlSeconds = typeof cfg.expiresInSeconds === 'number' ? cfg.expiresInSeconds : 3600;
  const secret: string = password;

  return {
    name: 'static',
    getCredential(): Promise<Credential> {
      return Promise.resolve({ username, password: secret, expiresAt: now() + ttlSeconds * 1000 });
    },
  };
}
