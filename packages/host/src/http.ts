/**
 * Per-request HTTP for providers.
 *
 * Node's native fetch reads proxy variables once, when its dispatcher is created, so a command that
 * wants a different proxy cannot get one by editing `process.env` (verified on 24.22: a later
 * `http_proxy` change is ignored). `node-fetch-native` supplies the node-fetch agents (a direct
 * pair, or `createProxy().agent` for an explicit proxy), and `x-fetch` wraps that fetch. The wrapped
 * instance is cached by the effective proxy choice, so a busy broker does not create an agent per
 * command.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import http from 'node:http';
import https from 'node:https';
import { createProxy } from 'node-fetch-native/proxy';
import { fetch as directFetch } from 'node-fetch-native/node';
import { createXFetch, isXFetchError, type XFetchMiddleware } from 'x-fetch';
import type { FetchLike } from 'gcb-cli';

/** A command's proxy choice: omitted keeps the host environment, null is direct. */
export type ProxyChoice = string | null | undefined;

/** Parse a proxy choice; false means it is not a usable http(s) URL. */
export function parseProxy(value: unknown): ProxyChoice | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : false;
  } catch {
    return false;
  }
}

const context = new AsyncLocalStorage<{ proxy: ProxyChoice }>();
const instances = new Map<string, FetchLike>();

/** Pass the current HTTP layer the proxy choice for one request. */
export function withProxy<T>(proxy: ProxyChoice, fn: () => T): T {
  return context.run({ proxy }, fn);
}

/** Return the stable key for one proxy choice. */
export function proxyCacheKey(proxy: ProxyChoice): string {
  if (proxy === null) return 'direct';
  if (proxy !== undefined) return `proxy:${proxy}`;
  return `env:${process.env['https_proxy'] ?? ''}|${process.env['HTTPS_PROXY'] ?? ''}|${process.env['http_proxy'] ?? ''}|${process.env['HTTP_PROXY'] ?? ''}|${process.env['no_proxy'] ?? ''}|${process.env['NO_PROXY'] ?? ''}|${process.env['NODE_USE_ENV_PROXY'] ?? ''}`;
}

/**
 * x-fetch throws on non-2xx, while every provider here wants to inspect the status and body itself.
 * Turn the thrown error back into its response for this adapter.
 */
const returnResponse: XFetchMiddleware = async (_ctx, next) => {
  try {
    return await next();
  } catch (error) {
    if (isXFetchError(error) && error.response !== undefined) return error.response;
    throw error;
  }
};

function nodeFetchWithAgent(agentFor: (url: URL) => http.Agent | https.Agent): typeof globalThis.fetch {
  // Pass the selector, not its result: node-fetch calls it per request, including redirects, so a
  // redirect that changes scheme gets the right agent.
  return ((url: string, init: RequestInit = {}) =>
    directFetch(url, { ...init, agent: agentFor } as RequestInit & { agent: unknown })) as typeof globalThis.fetch;
}

function makeFetch(proxy: ProxyChoice): FetchLike {
  let native: typeof globalThis.fetch;
  if (proxy === undefined) {
    native = globalThis.fetch;
  } else if (proxy === null) {
    // node-fetch's global agents are the ones Node points at the environment proxy when
    // NODE_USE_ENV_PROXY=1, so a direct choice needs its own agents rather than agent: false.
    const httpAgent = new http.Agent();
    const httpsAgent = new https.Agent();
    native = nodeFetchWithAgent((url) => (url.protocol === 'https:' ? httpsAgent : httpAgent));
  } else {
    // createProxy's agent is a node-fetch agent; this works on Node 24 and 26, unlike handing its
    // bundled undici dispatcher to the native fetch (Node 26 rejects that dispatcher).
    const agent = createProxy({ url: proxy, noProxy: [] }).agent;
    native = nodeFetchWithAgent(() => agent as http.Agent);
  }
  const instance = createXFetch(native);
  instance.middlewares.use(returnResponse);
  const raw = instance.xfetch as (url: string, options: unknown) => Promise<Response>;
  return (url, init) => raw(url, { ...init, type: null });
}

/** The current proxy's cache key, for provider caches that must not cross choices. */
export function currentProxyKey(): string {
  return proxyCacheKey(context.getStore()?.proxy);
}

/** The fetch instance for a proxy choice, created once per effective choice. */
export function fetcherFor(proxy: ProxyChoice): FetchLike {
  const key = proxyCacheKey(proxy);
  let fetcher = instances.get(key);
  if (fetcher === undefined) {
    // A command may name a different proxy every time; keep the reuse bounded rather than letting
    // arbitrary URLs grow this map for the life of the broker.
    if (instances.size >= 16) {
      const oldest = instances.keys().next().value;
      if (oldest !== undefined) instances.delete(oldest);
    }
    fetcher = makeFetch(proxy);
    instances.set(key, fetcher);
  }
  return fetcher;
}

/** Fetch using the proxy choice of the current request. */
export const proxyFetch: FetchLike = (url, init) => {
  const current = context.getStore();
  return fetcherFor(current?.proxy)(url, init);
};
