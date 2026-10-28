import { z } from 'zod';
import type { CapabilityInput, CapabilityName } from '../capabilities.js';
import { ProviderError } from '../errors.js';
import { requestJson } from '../http.js';
import type { AdapterResult, FetchFn, InvokeContext, ProviderAdapter } from '../types.js';
import { parseUpstream, unsupported } from './shared.js';

const ID = 'jina';

export interface JinaAdapterOptions {
  apiKey?: string;
  /** Reader works without a key at a low per-IP rate limit; it stays off unless explicitly opted in. */
  readerKeyless: boolean;
  embeddingModel: string;
  rerankModel: string;
  fetchImpl?: FetchFn;
}

// Shapes per https://api.jina.ai/openapi.json (EmbeddingResponse, RerankingResponse).
const embeddingResponse = z.object({
  model: z.string(),
  data: z.array(z.object({ index: z.number().int(), embedding: z.array(z.number()) })),
  usage: z.object({ total_tokens: z.number() }).partial().optional(),
});

const rerankResponse = z.object({
  model: z.string(),
  results: z.array(
    z.object({
      index: z.number().int(),
      relevance_score: z.number(),
    }),
  ),
  usage: z.object({ total_tokens: z.number() }).partial().optional(),
});

// Reader JSON mode (Accept: application/json) wraps the page in `data`.
const readerResponse = z.object({
  data: z.object({
    url: z.string().optional(),
    title: z.string().optional().nullable(),
    content: z.string(),
    usage: z.object({ tokens: z.number() }).partial().optional(),
  }),
});

/** Jina AI: embeddings, reranking and the Reader (URL → clean markdown). */
export class JinaAdapter implements ProviderAdapter {
  readonly id = ID;
  readonly displayName = 'Jina AI';
  readonly capabilities = ['text.embed', 'text.rerank', 'web.extract'] as const;
  readonly isMock = false;
  readonly requiredConfig = 'JINA_API_KEY';
  readonly docsUrl = 'https://jina.ai/';
  private readonly fetchImpl: FetchFn;

  constructor(private readonly opts: JinaAdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.opts.apiKey) || this.opts.readerKeyless;
  }

  /** Per-capability configuration: embed/rerank always need a key. */
  isCapabilityConfigured(capability: CapabilityName): boolean {
    if (capability === 'web.extract') return this.isConfigured();
    return Boolean(this.opts.apiKey);
  }

  private authHeaders(): Record<string, string> {
    return this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {};
  }

  async invoke(capability: CapabilityName, input: unknown, ctx: InvokeContext): Promise<AdapterResult> {
    if (!this.isCapabilityConfigured(capability)) {
      throw new ProviderError('not_configured', ID, `JINA_API_KEY is required for ${capability}`);
    }
    switch (capability) {
      case 'text.embed':
        return this.embed(input as CapabilityInput<'text.embed'>, ctx);
      case 'text.rerank':
        return this.rerank(input as CapabilityInput<'text.rerank'>, ctx);
      case 'web.extract':
        return this.extract(input as CapabilityInput<'web.extract'>, ctx);
      default:
        return unsupported(ID, capability);
    }
  }

  private async embed(input: CapabilityInput<'text.embed'>, ctx: InvokeContext): Promise<AdapterResult> {
    const raw = await requestJson({
      provider: ID,
      url: 'https://api.jina.ai/v1/embeddings',
      method: 'POST',
      headers: this.authHeaders(),
      body: {
        model: this.opts.embeddingModel,
        input: input.texts,
        ...(input.task ? { task: input.task } : {}),
        ...(input.dimensions ? { dimensions: input.dimensions } : {}),
      },
      fetchImpl: this.fetchImpl,
      ctx,
    });
    const parsed = parseUpstream(embeddingResponse, raw, ID);
    if (parsed.data.length !== input.texts.length) {
      throw new ProviderError('malformed_response', ID, 'Embedding count does not match input count');
    }
    const embeddings = [...parsed.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return {
      output: { model: parsed.model, dimensions: embeddings[0]?.length ?? 0, embeddings },
      model: parsed.model,
      usage: { totalTokens: parsed.usage?.total_tokens },
    };
  }

  private async rerank(input: CapabilityInput<'text.rerank'>, ctx: InvokeContext): Promise<AdapterResult> {
    const raw = await requestJson({
      provider: ID,
      url: 'https://api.jina.ai/v1/rerank',
      method: 'POST',
      headers: this.authHeaders(),
      body: {
        model: this.opts.rerankModel,
        query: input.query,
        documents: input.documents,
        return_documents: false,
        ...(input.topN ? { top_n: input.topN } : {}),
      },
      fetchImpl: this.fetchImpl,
      ctx,
    });
    const parsed = parseUpstream(rerankResponse, raw, ID);
    const results = parsed.results.map((r) => {
      const document = input.documents[r.index];
      if (document === undefined) {
        throw new ProviderError('malformed_response', ID, `Rerank index ${r.index} out of range`);
      }
      return { index: r.index, score: r.relevance_score, document };
    });
    return {
      output: { model: parsed.model, results },
      model: parsed.model,
      usage: { totalTokens: parsed.usage?.total_tokens },
    };
  }

  private async extract(input: CapabilityInput<'web.extract'>, ctx: InvokeContext): Promise<AdapterResult> {
    // The target URL has already passed the SSRF guard in the ProviderManager. It travels in the
    // JSON body (Reader's POST form) so query strings and #fragments reach Reader intact.
    let raw: unknown;
    try {
      raw = await requestJson({
        provider: ID,
        url: 'https://r.jina.ai/',
        method: 'POST',
        headers: this.authHeaders(),
        body: { url: input.url },
        fetchImpl: this.fetchImpl,
        ctx,
      });
    } catch (err) {
      throw normalizeReaderError(err);
    }
    const parsed = parseUpstream(readerResponse, raw, ID);
    return {
      output: { url: parsed.data.url ?? input.url, title: parsed.data.title ?? '', content: parsed.data.content },
      usage: { totalTokens: parsed.data.usage?.tokens },
    };
  }
}

// Reader error bodies look like { code, name, message, readableMessage }.
const readerErrorBody = z.object({ message: z.string().optional(), readableMessage: z.string().optional() }).passthrough();

/**
 * Turn Reader HTTP failures into short, safe messages: 402 = account balance exhausted (quota),
 * other statuses keep the generic code mapping (e.g. 422 = Reader could not load the page).
 */
function normalizeReaderError(err: unknown): unknown {
  if (!(err instanceof ProviderError) || err.options.status === undefined) return err;
  const status = err.options.status;
  const body = err.message.replace(/^HTTP \d+: /, '');
  let reason = '';
  try {
    const parsed = readerErrorBody.safeParse(JSON.parse(body));
    if (parsed.success) reason = (parsed.data.readableMessage ?? parsed.data.message ?? '').slice(0, 200);
  } catch {
    // Body was truncated or not JSON; fall back to the status alone.
  }
  const code = status === 402 ? 'quota_exceeded' : err.code;
  const what =
    status === 402 ? 'Jina account balance exhausted'
    : status === 401 || status === 403 ? 'Jina rejected the API key'
    : status === 429 ? 'Jina rate limit reached'
    : status >= 500 ? 'Jina Reader is unavailable'
    : 'Jina Reader could not read the page';
  return new ProviderError(code, ID, `${what} (HTTP ${status})${reason ? `: ${reason}` : ''}`, err.options);
}
