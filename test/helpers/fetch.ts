import type { FetchFn } from '../../src/providers/types.js';

export type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/**
 * Scripted fetch for tests. Routes are matched by `host + pathname` prefix; any unmatched URL
 * throws so a test can never reach a real network endpoint by accident.
 */
export function mockFetch(routes: Record<string, Route | Route[]>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const counters = new Map<string, number>();
  const fn: FetchFn = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url: url.href, init });
    const key = Object.keys(routes).find((k) => `${url.host}${url.pathname}`.startsWith(k));
    if (!key) throw new Error(`Unexpected fetch in test: ${url.href}`);
    const handler = routes[key]!;
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    const route = Array.isArray(handler) ? handler[Math.min(n, handler.length - 1)]! : handler;
    return route(url, init);
  };
  return { fetch: fn, calls };
}

/** A route that never responds until the request is aborted (simulates a hung provider). */
export const hang: Route = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
