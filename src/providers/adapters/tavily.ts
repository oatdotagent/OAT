import { z } from 'zod';
import type { CapabilityInput, CapabilityName } from '../capabilities.js';
import { ProviderError } from '../errors.js';
import { requestJson } from '../http.js';
import type { AdapterResult, FetchFn, InvokeContext, ProviderAdapter } from '../types.js';
import { parseUpstream, unsupported } from './shared.js';

const ID = 'tavily';
const BASE = 'https://api.tavily.com';
const MAX_SNIPPET = 1000;

// https://docs.tavily.com/documentation/api-reference/endpoint/search
const searchResponse = z.object({
  results: z.array(
    z.object({
      url: z.string(),
      title: z.string().nullable().optional(),
      content: z.string().nullable().optional(),
    }),
  ),
  usage: z.object({ credits: z.number() }).partial().optional(),
});

/**
 * Tavily Search API (web search). The key travels in the Authorization header only.
 * Tavily-specific statuses: 432 = key/plan limit exceeded, 433 = pay-as-you-go limit exceeded.
 * Both mean "out of credit": not worth retrying, but another web.search provider (Exa) may serve.
 */
export class TavilySearchAdapter implements ProviderAdapter {
  readonly id = ID;
  readonly displayName = 'Tavily';
  readonly capabilities = ['web.search'] as const;
  readonly isMock = false;
  readonly requiredConfig = 'TAVILY_API_KEY';
  readonly docsUrl = 'https://docs.tavily.com';
  private readonly fetchImpl: FetchFn;

  constructor(private readonly opts: { apiKey?: string; fetchImpl?: FetchFn }) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.apiKey}` };
  }

  async invoke(capability: CapabilityName, input: unknown, ctx: InvokeContext): Promise<AdapterResult> {
    if (capability !== 'web.search') unsupported(ID, capability);
    if (!this.opts.apiKey) throw new ProviderError('not_configured', ID, 'TAVILY_API_KEY is not set');
    const { query, count } = input as CapabilityInput<'web.search'>;

    let raw: unknown;
    try {
      raw = await requestJson({
        provider: ID,
        url: `${BASE}/search`,
        method: 'POST',
        headers: this.headers(),
        // Explicit basic depth (1 credit per call); no LLM answer or raw page content requested.
        body: { query, max_results: count ?? 10, search_depth: 'basic', topic: 'general', include_answer: false, include_raw_content: false },
        fetchImpl: this.fetchImpl,
        ctx,
      });
    } catch (err) {
      throw normalizeTavilyError(err);
    }

    const parsed = parseUpstream(searchResponse, raw, ID);
    // An empty result list is a valid answer, not an error; workflows can require results via
    // verification criteria (e.g. min_items). Entries without a usable URL are dropped.
    const results = parsed.results
      .filter((r) => /^https?:\/\//i.test(r.url))
      .map((r) => ({ title: r.title ?? '', url: r.url, snippet: (r.content ?? '').slice(0, MAX_SNIPPET) }));
    return { output: { results }, usage: { requests: 1 } };
  }

  /**
   * GET /usage reports the key's credit usage without running a search. Tavily rate-limits it
   * tightly (10 requests per 10 minutes), so it backs only the admin-triggered active probe.
   */
  async healthCheck(ctx: InvokeContext): Promise<void> {
    if (!this.opts.apiKey) throw new ProviderError('not_configured', ID, 'TAVILY_API_KEY is not set');
    try {
      await requestJson({ provider: ID, url: `${BASE}/usage`, headers: this.headers(), fetchImpl: this.fetchImpl, ctx });
    } catch (err) {
      throw normalizeTavilyError(err);
    }
  }
}

/** Map Tavily's credit-limit statuses (432/433) to quota_exceeded; everything else keeps the generic mapping. */
function normalizeTavilyError(err: unknown): unknown {
  if (err instanceof ProviderError && (err.options.status === 432 || err.options.status === 433)) {
    const which = err.options.status === 432 ? 'plan or key usage limit' : 'pay-as-you-go limit';
    return new ProviderError('quota_exceeded', ID, `Tavily ${which} reached (HTTP ${err.options.status})`, { status: err.options.status });
  }
  return err;
}
