import { z } from 'zod';
import type { CapabilityInput, CapabilityName } from '../capabilities.js';
import { ProviderError } from '../errors.js';
import { requestJson } from '../http.js';
import type { AdapterResult, FetchFn, InvokeContext, ProviderAdapter } from '../types.js';
import { parseUpstream, unsupported } from './shared.js';

const ID = 'exa';

// https://exa.ai/docs/reference/search
const searchResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().nullable().optional(),
      url: z.string(),
      highlights: z.array(z.string()).optional(),
      text: z.string().optional(),
    }),
  ),
  costDollars: z.object({ total: z.number() }).partial().optional(),
});

/** Exa search. Registered as a compatible fallback for web.search. */
export class ExaSearchAdapter implements ProviderAdapter {
  readonly id = ID;
  readonly displayName = 'Exa';
  readonly capabilities = ['web.search'] as const;
  readonly isMock = false;
  readonly requiredConfig = 'EXA_API_KEY';
  readonly docsUrl = 'https://exa.ai/docs';
  private readonly fetchImpl: FetchFn;

  constructor(private readonly opts: { apiKey?: string; fetchImpl?: FetchFn }) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  async invoke(capability: CapabilityName, input: unknown, ctx: InvokeContext): Promise<AdapterResult> {
    if (capability !== 'web.search') unsupported(ID, capability);
    if (!this.opts.apiKey) throw new ProviderError('not_configured', ID, 'EXA_API_KEY is not set');
    const { query, count } = input as CapabilityInput<'web.search'>;
    const raw = await requestJson({
      provider: ID,
      url: 'https://api.exa.ai/search',
      method: 'POST',
      headers: { 'x-api-key': this.opts.apiKey },
      body: { query, numResults: count ?? 10, type: 'auto', contents: { highlights: true } },
      fetchImpl: this.fetchImpl,
      ctx,
    });
    const parsed = parseUpstream(searchResponse, raw, ID);
    // Same shape and filtering as the primary (Tavily), so a fallback answer looks identical downstream.
    const results = parsed.results
      .filter((r) => /^https?:\/\//i.test(r.url))
      .map((r) => ({
        title: r.title ?? '',
        url: r.url,
        snippet: (r.highlights?.length ? r.highlights.join(' … ') : (r.text ?? '')).slice(0, 1000),
      }));
    return {
      output: { results },
      usage: { requests: 1 },
      // Exa reports its own cost estimate per request.
      ...(parsed.costDollars?.total !== undefined ? { estimatedCostUsd: parsed.costDollars.total } : {}),
    };
  }
}
