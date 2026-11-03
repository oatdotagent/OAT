import { z } from 'zod';
import type { CapabilityInput, CapabilityName } from '../capabilities.js';
import { ProviderError } from '../errors.js';
import { requestJson, type ErrorOverride } from '../http.js';
import type { AdapterResult, FetchFn, InvokeContext, ProviderAdapter } from '../types.js';
import { parseUpstream, unsupported } from './shared.js';

const ID = 'gemini';
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiAdapterOptions {
  apiKey?: string;
  model: string;
  maxOutputTokens: number;
  fetchImpl?: FetchFn;
}

// Shapes per https://ai.google.dev/api/generate-content (GenerateContentResponse).
const generateResponse = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })).optional() })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      thoughtsTokenCount: z.number().optional(),
      totalTokenCount: z.number().optional(),
    })
    .optional(),
  modelVersion: z.string().optional(),
});

// Finish reasons that mean the provider declined or filtered the output.
const DECLINED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE', 'ESCALATION', 'PUP_LIMITED_DISABLED']);

/**
 * Google Gemini API (Google AI Studio key). Free-tier eligible models are listed at
 * https://ai.google.dev/gemini-api/docs/pricing — on the free tier Google may use prompts and
 * outputs to improve its products. No cost is estimated here: whether a call is billed depends on
 * the key's tier, which the API does not report.
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly id = ID;
  readonly displayName = 'Google Gemini';
  readonly capabilities = ['llm.generate'] as const;
  readonly isMock = false;
  readonly requiredConfig = 'GEMINI_API_KEY';
  readonly docsUrl = 'https://ai.google.dev/gemini-api/docs';
  private readonly fetchImpl: FetchFn;

  constructor(private readonly opts: GeminiAdapterOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  // The key travels in a header, never in the URL, so it can't leak through URLs or access logs.
  private headers(): Record<string, string> {
    return { 'x-goog-api-key': this.opts.apiKey! };
  }

  private modelPath(): string {
    return `models/${encodeURIComponent(this.opts.model)}`;
  }

  async invoke(capability: CapabilityName, input: unknown, ctx: InvokeContext): Promise<AdapterResult> {
    if (capability !== 'llm.generate') unsupported(ID, capability);
    if (!this.opts.apiKey) throw new ProviderError('not_configured', ID, 'GEMINI_API_KEY is not set');
    const { prompt, system, maxTokens } = input as CapabilityInput<'llm.generate'>;

    let raw: unknown;
    try {
      raw = await requestJson({
        provider: ID,
        url: `${BASE}/${this.modelPath()}:generateContent`,
        method: 'POST',
        headers: this.headers(),
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: { maxOutputTokens: Math.min(maxTokens ?? this.opts.maxOutputTokens, this.opts.maxOutputTokens) },
        },
        fetchImpl: this.fetchImpl,
        ctx,
        classifyError: classifyQuotaError,
      });
    } catch (err) {
      throw normalizeKeyError(err);
    }
    const parsed = parseUpstream(generateResponse, raw, ID);

    if (parsed.promptFeedback?.blockReason) {
      throw new ProviderError('refused', ID, `Prompt was blocked (reason: ${parsed.promptFeedback.blockReason})`);
    }
    const candidate = parsed.candidates?.[0];
    if (!candidate) throw new ProviderError('malformed_response', ID, 'Response contained no candidates');
    const finishReason = candidate.finishReason ?? null;
    if (finishReason && DECLINED.has(finishReason)) {
      throw new ProviderError('refused', ID, `Model output was withheld (finish reason: ${finishReason})`);
    }

    // Thought summaries (thought: true) are not part of the answer.
    const text = (candidate.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');

    const u = parsed.usageMetadata;
    const outputTokens = u?.candidatesTokenCount !== undefined || u?.thoughtsTokenCount !== undefined ? (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) : undefined;
    const model = parsed.modelVersion ?? this.opts.model;
    return {
      output: { text, model, stopReason: finishReason },
      model,
      usage: { inputTokens: u?.promptTokenCount, outputTokens, totalTokens: u?.totalTokenCount },
    };
  }

  /** Model metadata lookup (models.get): checks the key and model without generating any text. */
  async healthCheck(ctx: InvokeContext): Promise<void> {
    if (!this.opts.apiKey) throw new ProviderError('not_configured', ID, 'GEMINI_API_KEY is not set');
    try {
      await requestJson({ provider: ID, url: `${BASE}/${this.modelPath()}`, headers: this.headers(), fetchImpl: this.fetchImpl, ctx });
    } catch (err) {
      throw normalizeKeyError(err);
    }
  }
}

const quotaError = z.object({
  error: z.object({
    details: z
      .array(
        z.looseObject({
          violations: z.array(z.looseObject({ quotaId: z.string().optional() })).optional(),
          retryDelay: z.string().optional(),
        }),
      )
      .optional(),
  }),
});

/**
 * A 429 can mean a per-minute limit, which is worth retrying after the delay Gemini states in the body,
 * or a daily limit, which retrying cannot fix: that becomes quota_exceeded, so it fails at once and clearly.
 */
export function classifyQuotaError(status: number, body: string): ErrorOverride | undefined {
  if (status !== 429) return undefined;
  let details: z.infer<typeof quotaError>['error']['details'];
  try {
    details = quotaError.parse(JSON.parse(body)).error.details;
  } catch {
    return undefined;
  }
  const daily = details?.some((d) => d.violations?.some((v) => /PerDay/i.test(v.quotaId ?? '')));
  if (daily) {
    return { code: 'quota_exceeded', message: 'Gemini daily quota is used up. It resets once a day; a paid plan on the key raises the limit.' };
  }
  const delay = details?.map((d) => d.retryDelay?.match(/^(\d+(?:\.\d+)?)s$/)?.[1]).find(Boolean);
  return delay ? { retryAfterMs: Math.min(Math.ceil(Number(delay) * 1000), 60_000) } : undefined;
}

/** Gemini reports an invalid key as HTTP 400 (INVALID_ARGUMENT / API_KEY_INVALID); surface it as auth_failed. */
function normalizeKeyError(err: unknown): unknown {
  if (err instanceof ProviderError && err.options.status === 400 && /API_KEY_INVALID|API key not valid/i.test(err.message)) {
    return new ProviderError('auth_failed', ID, 'Gemini rejected the API key', { status: 400 });
  }
  return err;
}
