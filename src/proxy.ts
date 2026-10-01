/**
 * The fetch every GitHub call in this process should use.
 *
 * `node-fetch-native`'s proxy module reads `https_proxy` / `http_proxy` / `HTTPS_PROXY` / `HTTP_PROXY` and
 * `no_proxy` at import time and binds a fetch to the resulting dispatcher, so importing it is the whole
 * bootstrap. With none of those set it behaves exactly as `fetch` does, which is why nothing here has to
 * check whether a proxy is in use.
 *
 * Worth keeping in one place, with this note: Node's own `fetch` does not read those variables. Measured on
 * 24.21, plain variables and `--use-env-proxy` both went straight at the target — and where the container
 * sets `NODE_USE_ENV_PROXY=1` and `all_proxy`, the same URL that answers 200 through this fetch answers 404
 * through the built-in one. "It connected" and "it was right" are not the same thing.
 *
 * The module exports `fetch` as `createFetch({})`, so this is the same object under a name that says which
 * one it is.
 */
export { fetch as proxyFetch } from 'node-fetch-native/proxy';
