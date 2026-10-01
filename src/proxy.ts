/**
 * Make the process honour the proxy the deployment was started with.
 *
 * Node's `fetch` does not read `http_proxy` at all — measured on 24.21 three ways: plain environment
 * variables, `NODE_USE_ENV_PROXY=1`, and `--use-env-proxy`; in every case the proxy was never contacted and
 * the connection went straight at the target. `global-agent`, which is the usual answer for this, sets
 * `http.globalAgent` and so helps the clients that use the `http` module — axios, got, octokit — and none
 * of the calls here, because every one of them is `fetch`.
 *
 * undici's `EnvHttpProxyAgent` is the same idea for `fetch`: it reads the variables itself, honours
 * `no_proxy`, and takes over the global dispatcher.
 */
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/** Whether this process has already decided. Late calls are no-ops, not re-decisions. */
let decided = false;

/**
 * Install a proxy dispatcher when the environment asks for one.
 *
 * Called once from a process entry point, because the variables arrive with the process: whatever starts
 * this — a systemd unit, a compose file, a shell — passes them in.
 *
 * @param env - the environment to read, for a test.
 * @returns true when a proxy was installed, false when the deployment has none.
 */
export function bootstrapProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  if (decided) return false;
  decided = true;

  const wanted = [env['http_proxy'], env['HTTP_PROXY'], env['https_proxy'], env['HTTPS_PROXY']];
  if (!wanted.some((value) => typeof value === 'string' && value !== '')) return false;

  setGlobalDispatcher(new EnvHttpProxyAgent());
  return true;
}
