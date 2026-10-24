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
// Only the spellings Node's fetch actually reads. all_proxy is deliberately absent: measured on 24.21, a
// fetch goes direct with all_proxy set and NODE_USE_ENV_PROXY=1, so naming it here would tell an operator
// to set a variable that changes nothing and leave them with the silent direct connection this refuses.
const PROXY_VARS = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY'] as const;

/**
 * Fail when a proxy is set but this process would ignore it.
 *
 * Called once from a process entry point, before any call leaves the machine.
 *
 * @param env - the environment to read, for a test.
 * @param execArgv - the process arguments, for the command-line spelling of the same switch.
 * @throws {Error} when a proxy variable is set and nothing would make fetch use it.
 */
export function assertProxyEnabled(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): void {
  // The proxy support this file stands in for arrived in Node 24, and the package asks for it. A host on an
  // older interpreter would read a switch that does nothing there, so this is checked rather than assumed.
  const major = Number((process.versions.node ?? '0').split('.')[0]);
  if (major < 24) {
    throw new Error(
      `Node ${process.versions.node} is older than this needs: install Node 24 or newer, or every GitHub\n` +
        '  call will ignore the proxy environment variables this refuses over.',
    );
  }
  const wanted = PROXY_VARS.filter((name) => {
    const value = env[name];
    return typeof value === 'string' && value !== '';
  });
  if (wanted.length === 0) return;
  // `--use-env-proxy` is the same switch on the command line, and NODE_OPTIONS can carry it too.
  // `--no-use-env-proxy` is not another way to allow this: it switches the feature off, which leaves the
  // proxy variables set and unread — the state this refuses, because the broker then goes direct and times
  // out. Node 24.5 gives it precedence over both NODE_OPTIONS and NODE_USE_ENV_PROXY. Both are compared as
  // whole tokens, so `--use-env-proxy` cannot be found inside another word.
  const options = `${env['NODE_OPTIONS'] ?? ''}`.split(/\s+/).filter((token) => token !== '');
  const off = execArgv.includes('--no-use-env-proxy') || options.includes('--no-use-env-proxy');
  const on =
    env['NODE_USE_ENV_PROXY'] === '1' ||
    execArgv.includes('--use-env-proxy') ||
    options.includes('--use-env-proxy');
  if (on && !off) return;

  throw new Error(
    `${wanted[0]} is set, but Node's fetch will ignore it: set NODE_USE_ENV_PROXY=1 in this process's\n` +
      '  environment (section "Set up a proxy" in the README), or unset the proxy variables if this host\n' +
      '  reaches github.com directly. Without it the broker either times out or leaves by another route.',
  );
}
