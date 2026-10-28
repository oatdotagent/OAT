import Anthropic from '@anthropic-ai/sdk';
import type { CapabilityInput, CapabilityName } from '../capabilities.js';
import { ProviderError } from '../errors.js';
import type { AdapterResult, InvokeContext, ProviderAdapter } from '../types.js';
import { unsupported } from './shared.js';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicAdapterOptions {
  apiKey?: string;
  model: string;
  effort: Effort;
  maxTokens: number;
  /** Injectable for tests; defaults to the official SDK client. */
  client?: Pick<Anthropic, 'beta' | 'models'>;
}

// Published first-party per-MTok rates (USD) used only for *estimates*; unknown models report no cost.
const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

// Models that accept the server-side refusal fallback in its "default" form on the Claude API.
const SERVER_FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

const ID = 'anthropic';

/** Claude via the official Anthropic SDK. Retries are owned by the ProviderManager (SDK retries disabled). */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id = ID;
  readonly displayName = 'Anthropic Claude';
  readonly capabilities = ['llm.generate'] as const;
  readonly isMock = false;
  readonly requiredConfig = 'ANTHROPIC_API_KEY';
  readonly docsUrl = 'https://platform.claude.com/docs';
  private client: Pick<Anthropic, 'beta' | 'models'> | undefined;

  constructor(private readonly opts: AnthropicAdapterOptions) {
    this.client = opts.client ?? (opts.apiKey ? new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 }) : undefined);
  }

  isConfigured(): boolean {
    return this.client !== undefined;
  }

  async invoke(capability: CapabilityName, input: unknown, ctx: InvokeContext): Promise<AdapterResult> {
    if (capability !== 'llm.generate') unsupported(ID, capability);
    if (!this.client) throw new ProviderError('not_configured', ID, 'ANTHROPIC_API_KEY is not set');
    const { prompt, system, maxTokens } = input as CapabilityInput<'llm.generate'>;
    const model = this.opts.model;
    const useFallback = SERVER_FALLBACK_MODELS.has(model);

    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create(
        {
          model,
          max_tokens: Math.min(maxTokens ?? this.opts.maxTokens, this.opts.maxTokens),
          ...(system ? { system } : {}),
          messages: [{ role: 'user', content: prompt }],
          output_config: { effort: this.opts.effort },
          ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        },
        { signal: ctx.signal, timeout: ctx.timeoutMs, maxRetries: 0 },
      );
    } catch (err) {
      throw mapAnthropicError(err, ctx);
    }

    // Always check stop_reason before reading content.
    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ?? 'unspecified';
      throw new ProviderError('refused', ID, `Model declined the request (category: ${category})`);
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const price = PRICING_PER_MTOK[response.model];
    return {
      output: { text, model: response.model, stopReason: response.stop_reason ?? null },
      model: response.model,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      ...(price
        ? { estimatedCostUsd: (inputTokens * price.input + outputTokens * price.output) / 1_000_000 }
        : {}),
    };
  }

  /** Model metadata lookup: verifies credentials and model access without generating tokens. */
  async healthCheck(ctx: InvokeContext): Promise<void> {
    if (!this.client) throw new ProviderError('not_configured', ID, 'ANTHROPIC_API_KEY is not set');
    try {
      await this.client.models.retrieve(this.opts.model, {}, { signal: ctx.signal, timeout: ctx.timeoutMs, maxRetries: 0 });
    } catch (err) {
      throw mapAnthropicError(err, ctx);
    }
  }
}

export function mapAnthropicError(err: unknown, ctx: InvokeContext): ProviderError {
  if (err instanceof ProviderError) return err;
  if (ctx.signal.aborted) return new ProviderError('cancelled', ID, 'Request cancelled');
  // Most specific first: timeout/connection errors subclass APIError.
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError('timeout', ID, `Request timed out after ${ctx.timeoutMs}ms`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError('network_error', ID, `Connection error: ${err.message}`);
  }
  if (err instanceof Anthropic.RateLimitError) {
    const header = err.headers?.get?.('retry-after') ?? null;
    const seconds = header ? Number(header) : NaN;
    return new ProviderError('rate_limited', ID, 'Rate limited by Anthropic', {
      status: 429,
      ...(Number.isFinite(seconds) ? { retryAfterMs: Math.min(seconds * 1000, 60_000) } : {}),
    });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError('auth_failed', ID, 'Anthropic rejected the credentials', { status: err.status });
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderError('not_found', ID, err.message, { status: 404 });
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.UnprocessableEntityError) {
    return new ProviderError('bad_request', ID, err.message, { status: err.status });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    return new ProviderError(status && status >= 500 ? 'upstream_error' : 'bad_request', ID, err.message, {
      ...(status !== undefined ? { status } : {}),
    });
  }
  return new ProviderError('upstream_error', ID, `Unexpected error: ${(err as Error)?.message ?? String(err)}`);
}
