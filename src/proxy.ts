/**
 * Refuse to start when a proxy is configured and the process will not use it.
 *
 * Node's own `fetch` only reads `http_proxy` / `https_proxy` when `NODE_USE_ENV_PROXY=1`, and that variable
 * arrived in Node 24. Since this project needs no fetch wrapper — the built-in one is enough on Node 24 once
 * the variable is set — the thing that replaces a dependency is a refusal: a deployment behind a proxy that
 * forgot the variable would otherwise reach GitHub directly, which is either a silent timeout or, worse, a
 * request that leaves by a route nobody chose.
 *
 * The check is written against the variables rather than the version on purpose: what matters is whether this
 * process will use the proxy, not which interpreter is running it.
 */

/** Variables that say a proxy is expected, in the spellings the ecosystem uses. */
const PROXY_VARS = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'] as const;

/**
 * Fail when a proxy is set but this process would ignore it.
 *
 * Called once from a process entry point, before any call leaves the machine.
 *
 * @param env - the environment to read, for a test.
 * @throws {Error} when a proxy variable is set and `NODE_USE_ENV_PROXY` is not `1`.
 */
export function assertProxyEnabled(env: NodeJS.ProcessEnv = process.env): void {
  const wanted = PROXY_VARS.filter((name) => {
    const value = env[name];
    return typeof value === 'string' && value !== '';
  });
  if (wanted.length === 0) return;
  if (env['NODE_USE_ENV_PROXY'] === '1') return;

  throw new Error(
    `${wanted[0]} is set, but Node's fetch will ignore it: set NODE_USE_ENV_PROXY=1 in this process's\n` +
      '  environment (section "Set up a proxy" in the README), or unset the proxy variables if this host\n' +
      '  reaches github.com directly. Without it the broker either times out or leaves by another route.',
  );
}
