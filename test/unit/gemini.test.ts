import { describe, expect, it } from 'vitest';
import { classifyQuotaError, GeminiAdapter } from '../../src/providers/adapters/gemini.js';
import { ProviderError } from '../../src/providers/errors.js';
import type { InvokeContext } from '../../src/providers/types.js';
import { hang, json, mockFetch, type Route } from '../helpers/fetch.js';

const KEY = 'gemini-test-key-0123456789';
const ctx = (timeoutMs = 2000): InvokeContext => ({ signal: new AbortController().signal, timeoutMs });
const make = (route: Route, opts: { apiKey?: string; model?: string } = {}) => {
  const m = mockFetch({ 'generativelanguage.googleapis.com': route });
  const adapter = new GeminiAdapter({ apiKey: 'apiKey' in opts ? opts.apiKey : KEY, model: opts.model ?? 'gemini-3.6-flash', maxOutputTokens: 8192, fetchImpl: m.fetch });
  return { adapter, calls: m.calls };
};

async function providerError(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return e as ProviderError;
  }
  throw new Error('expected ProviderError');
}

const ok = {
  candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text: 'Hello' }, { text: ' world' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 20, totalTokenCount: 35 },
  modelVersion: 'gemini-3.6-flash',
};

describe('GeminiAdapter', () => {
  it('generates text, skips thought parts, reports usage and no invented cost', async () => {
    const { adapter, calls } = make(() => json(ok));
    const res = await adapter.invoke('llm.generate', { prompt: 'hi', system: 'be brief', maxTokens: 999_999 }, ctx());
    expect(res.output).toEqual({ text: 'Hello world', model: 'gemini-3.6-flash', stopReason: 'STOP' });
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 23, totalTokens: 35 });
    expect(res.estimatedCostUsd).toBeUndefined();

    const call = calls[0]!;
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
    expect(call.init.method).toBe('POST');
    expect((call.init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    expect(JSON.parse(call.init.body as string)).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [{ text: 'be brief' }] },
      generationConfig: { maxOutputTokens: 8192 },
    });
  });

  it('never puts the API key in the URL', async () => {
    const { adapter, calls } = make(() => json(ok));
    await adapter.invoke('llm.generate', { prompt: 'hi' }, ctx());
    await adapter.healthCheck(ctx());
    for (const c of calls) expect(c.url).not.toContain(KEY);
    expect(calls[1]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash');
  });

  it('treats blocked prompts and safety stops as non-retryable refusals', async () => {
    const blocked = await providerError(make(() => json({ promptFeedback: { blockReason: 'SAFETY' } })).adapter.invoke('llm.generate', { prompt: 'x' }, ctx()));
    expect(blocked).toMatchObject({ code: 'refused', retryable: false });
    expect(blocked.message).toContain('SAFETY');
    const withheld = await providerError(make(() => json({ candidates: [{ finishReason: 'PROHIBITED_CONTENT' }] })).adapter.invoke('llm.generate', { prompt: 'x' }, ctx()));
    expect(withheld).toMatchObject({ code: 'refused', retryable: false });
  });

  it('returns truncated output honestly with stopReason MAX_TOKENS', async () => {
    const res = await make(() => json({ candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }] })).adapter.invoke('llm.generate', { prompt: 'x' }, ctx());
    expect(res.output).toMatchObject({ text: 'partial', stopReason: 'MAX_TOKENS' });
  });

  it('maps free-tier rate limits (429 RESOURCE_EXHAUSTED) to retryable rate_limited', async () => {
    const err = await providerError(
      make(() => json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }, 429, { 'retry-after': '7' })).adapter.invoke('llm.generate', { prompt: 'x' }, ctx()),
    );
    expect(err).toMatchObject({ code: 'rate_limited', retryable: true, options: { status: 429, retryAfterMs: 7000 } });
  });

  it('uses the retry delay from the error body when a per-minute limit has no Retry-After header', async () => {
    const body = { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '12.5s' },
    ] } };
    const err = await providerError(make(() => json(body, 429)).adapter.invoke('llm.generate', { prompt: 'hi' }, ctx()));
    expect(err).toMatchObject({ code: 'rate_limited', retryable: true, options: { retryAfterMs: 12_500 } });
  });

  it('caps a very long stated retry delay', () => {
    const body = JSON.stringify({ error: { details: [{ retryDelay: '900s' }] } });
    expect(classifyQuotaError(429, body)).toEqual({ retryAfterMs: 60_000 });
  });

  it('does not retry when the daily quota is used up, and says so plainly', async () => {
    const body = { error: { status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '57563s' },
    ] } };
    const err = await providerError(make(() => json(body, 429)).adapter.invoke('llm.generate', { prompt: 'hi' }, ctx()));
    expect(err).toMatchObject({ code: 'quota_exceeded', retryable: false, options: { status: 429 } });
    expect(err.message).toMatch(/daily quota/i);
  });

  it('leaves other statuses and unreadable bodies to the default mapping', () => {
    expect(classifyQuotaError(500, '{}')).toBeUndefined();
    expect(classifyQuotaError(429, 'not json')).toBeUndefined();
  });

  it('maps an invalid key (HTTP 400 API_KEY_INVALID) to auth_failed without echoing the key', async () => {
    const body = { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] } };
    const err = await providerError(make(() => json(body, 400)).adapter.invoke('llm.generate', { prompt: 'x' }, ctx()));
    expect(err).toMatchObject({ code: 'auth_failed', retryable: false });
    expect(err.message).not.toContain(KEY);
    const probe = await providerError(make(() => json(body, 400)).adapter.healthCheck(ctx()));
    expect(probe.code).toBe('auth_failed');
  });

  it('keeps other 400s as bad_request and 5xx as retryable upstream errors', async () => {
    expect((await providerError(make(() => json({ error: { code: 400, message: 'model not supported' } }, 400)).adapter.invoke('llm.generate', { prompt: 'x' }, ctx()))).code).toBe('bad_request');
    expect((await providerError(make(() => json({}, 503)).adapter.invoke('llm.generate', { prompt: 'x' }, ctx()))).retryable).toBe(true);
  });

  it('rejects malformed responses', async () => {
    expect((await providerError(make(() => json({ candidates: [] })).adapter.invoke('llm.generate', { prompt: 'x' }, ctx()))).code).toBe('malformed_response');
    expect((await providerError(make(() => json({ candidates: 'nope' })).adapter.invoke('llm.generate', { prompt: 'x' }, ctx()))).code).toBe('malformed_response');
    expect((await providerError(make(() => new Response('<html>', { status: 200 })).adapter.invoke('llm.generate', { prompt: 'x' }, ctx()))).code).toBe('malformed_response');
  });

  it('times out hung requests', async () => {
    const err = await providerError(make(hang).adapter.invoke('llm.generate', { prompt: 'x' }, ctx(50)));
    expect(err).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('is disabled without a key and makes no request', async () => {
    const { adapter, calls } = make(() => json(ok), { apiKey: undefined });
    expect(adapter.isConfigured()).toBe(false);
    expect((await providerError(adapter.invoke('llm.generate', { prompt: 'x' }, ctx()))).code).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });
});
