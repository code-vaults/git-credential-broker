/**
 * Provider factory: turns one host's configuration block into a credential source.
 *
 * Adding a provider for another forge means adding one module and one case here; the
 * broker, the helper, the socket protocol, the allowlist and the audit trail are all
 * provider-agnostic.
 */
import type { FetchLike, HostConfig, Provider } from '../types.ts';
import { createGithubAppProvider } from './github-app.ts';
import { createStaticProvider } from './static.ts';

/** Dependencies threaded through to providers, injectable for tests. */
export interface ProviderDeps {
  readonly skewSeconds?: number;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

/**
 * Build the provider for one host.
 *
 * @param host - the configured host key.
 * @param cfg - the per-host configuration block.
 * @param deps - injectable dependencies.
 * @returns the provider instance.
 * @throws {Error} for an unknown provider name, or when the provider's config is incomplete.
 */
export function createProvider(host: string, cfg: HostConfig, deps: ProviderDeps = {}): Provider {
  switch (cfg.provider) {
    case 'github-app':
      return createGithubAppProvider({
        host,
        cfg,
        skewSeconds: deps.skewSeconds,
        fetchImpl: deps.fetchImpl,
        now: deps.now,
      });
    case 'static':
      return createStaticProvider({ host, cfg, now: deps.now });
    default: {
      const exhaustive: never = cfg;
      throw new Error(`unknown provider for host ${host}: ${JSON.stringify(exhaustive)}`);
    }
  }
}
