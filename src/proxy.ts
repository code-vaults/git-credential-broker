/**
 * A fetch that honours the proxy the process was started with.
 *
 * The environment arrives with the process — a systemd unit, a compose file, a shell — and Node's own
 * `fetch` does not read it: measured on 24.21 three ways, plain `http_proxy`/`https_proxy`,
 * `NODE_USE_ENV_PROXY=1` and `--use-env-proxy`, the proxy was never contacted and the connection went
 * straight at the target. Behind a proxy that means every call fails by timeout, which is how this was
 * found: the OAuth exchange needs github.com, api.github.com answered, and nothing said which.
 *
 * `node-fetch-native`'s proxy module reads those variables itself, `no_proxy` included, and hands back both
 * halves of the answer: a `dispatcher` for `fetch` and an `agent` for the clients built on the `http`
 * module. This process only makes `fetch` calls, so it takes the dispatcher, bound to a fetch of its own so
 * nothing else in the process has to know.
 */
import { createFetch } from 'node-fetch-native/proxy';

/**
 * The fetch every GitHub call in this process should use.
 *
 * With no proxy variable set it behaves as `fetch` does, so a deployment that talks to GitHub directly is
 * unaffected.
 */
export const proxyFetch: typeof globalThis.fetch = createFetch();
