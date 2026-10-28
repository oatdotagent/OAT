import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/adapters/anthropic.js';
import { ExaSearchAdapter } from '../../src/providers/adapters/exa.js';
import { GitHubAdapter } from '../../src/providers/adapters/github.js';
import { JinaAdapter } from '../../src/providers/adapters/jina.js';
import { TavilySearchAdapter } from '../../src/providers/adapters/tavily.js';
import { ProviderError } from '../../src/providers/errors.js';
import type { InvokeContext } from '../../src/providers/types.js';
import { hang, json, mockFetch } from '../helpers/fetch.js';

const ctx = (timeoutMs = 2000): InvokeContext => ({ signal: new AbortController().signal, timeoutMs });

async function providerError(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return e as ProviderError;
  }
  throw new Error('expected ProviderError');
}

const jina = (fetchImpl: typeof fetch, apiKey: string | undefined = 'jina_testkey000000000000') =>
  new JinaAdapter({ apiKey, readerKeyless: false, embeddingModel: 'jina-embeddings-v5-text-small', rerankModel: 'jina-reranker-v3', fetchImpl });

describe('JinaAdapter', () => {
  it('embeds and restores input order by index; sends bearer auth', async () => {
    const m = mockFetch({
      'api.jina.ai/v1/embeddings': () =>
        json({ model: 'jina-embeddings-v5-text-small', data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { total_tokens: 7 } }),
    });
    const res = await jina(m.fetch).invoke('text.embed', { texts: ['a', 'b'] }, ctx());
    expect(res.output).toEqual({ model: 'jina-embeddings-v5-text-small', dimensions: 2, embeddings: [[1, 0], [0, 1]] });
    expect(res.usage?.totalTokens).toBe(7);
    expect((m.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer jina_testkey000000000000');
  });

  it('maps rerank results back to the original documents', async () => {
    const m = mockFetch({
      'api.jina.ai/v1/rerank': () => json({ model: 'jina-reranker-v3', results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }] }),
    });
    const res = await jina(m.fetch).invoke('text.rerank', { query: 'q', documents: ['d0', 'd1'] }, ctx());
    expect(res.output).toEqual({ model: 'jina-reranker-v3', results: [{ index: 1, score: 0.9, document: 'd1' }, { index: 0, score: 0.2, document: 'd0' }] });
  });

  it('rejects out-of-range rerank indices and mismatched embedding counts as malformed', async () => {
    const bad = mockFetch({
      'api.jina.ai/v1/rerank': () => json({ model: 'm', results: [{ index: 5, relevance_score: 1 }] }),
      'api.jina.ai/v1/embeddings': () => json({ model: 'm', data: [{ index: 0, embedding: [1] }] }),
    });
    expect((await providerError(jina(bad.fetch).invoke('text.rerank', { query: 'q', documents: ['a'] }, ctx()))).code).toBe('malformed_response');
    expect((await providerError(jina(bad.fetch).invoke('text.embed', { texts: ['a', 'b'] }, ctx()))).code).toBe('malformed_response');
  });

  it('extracts pages via the Reader JSON mode', async () => {
    const m = mockFetch({ 'r.jina.ai/': () => json({ code: 200, data: { url: 'https://example.com/', title: 'Example', content: '# Hello' } }) });
    const res = await jina(m.fetch).invoke('web.extract', { url: 'https://example.com/' }, ctx());
    expect(res.output).toEqual({ url: 'https://example.com/', title: 'Example', content: '# Hello' });
    expect(m.calls[0]!.url).toBe('https://r.jina.ai/');
    expect(m.calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(m.calls[0]!.init.body as string)).toEqual({ url: 'https://example.com/' });
  });

  it('sends query strings and fragments intact in the body', async () => {
    const m = mockFetch({ 'r.jina.ai/': () => json({ data: { content: 'x' } }) });
    await jina(m.fetch).invoke('web.extract', { url: 'https://example.com/a?b=1&c=2#/route' }, ctx());
    expect(JSON.parse(m.calls[0]!.init.body as string)).toEqual({ url: 'https://example.com/a?b=1&c=2#/route' });
  });

  it('turns an unreadable page into a short, non-retryable error', async () => {
    const m = mockFetch({
      'r.jina.ai/': () => json({ data: null, code: 422, name: 'AssertionFailureError', readableMessage: 'AssertionFailureError: Failed to goto https://example.com/' }, 422),
    });
    const err = await providerError(jina(m.fetch).invoke('web.extract', { url: 'https://example.com/' }, ctx()));
    expect(err).toMatchObject({ code: 'bad_request', retryable: false });
    expect(err.message).toBe('Jina Reader could not read the page (HTTP 422): AssertionFailureError: Failed to goto https://example.com/');
  });

  it('maps HTTP 402 (balance exhausted) to quota_exceeded', async () => {
    const m = mockFetch({ 'r.jina.ai/': () => json({ code: 402, name: 'InsufficientBalanceError', message: 'Account balance not enough' }, 402) });
    const err = await providerError(jina(m.fetch).invoke('web.extract', { url: 'https://example.com/' }, ctx()));
    expect(err).toMatchObject({ code: 'quota_exceeded', retryable: false });
    expect(err.message).toBe('Jina account balance exhausted (HTTP 402): Account balance not enough');
  });

  it('times out a hung Reader request', async () => {
    const m = mockFetch({ 'r.jina.ai/': hang });
    const err = await providerError(jina(m.fetch).invoke('web.extract', { url: 'https://example.com/' }, ctx(50)));
    expect(err.code).toBe('timeout');
  });

  it('requires a key for embed/rerank but allows keyless Reader when opted in', async () => {
    const keyless = new JinaAdapter({ readerKeyless: true, embeddingModel: 'm', rerankModel: 'm', fetchImpl: mockFetch({}).fetch });
    expect(keyless.isCapabilityConfigured('web.extract')).toBe(true);
    expect(keyless.isCapabilityConfigured('text.embed')).toBe(false);
    expect((await providerError(keyless.invoke('text.embed', { texts: ['a'] }, ctx()))).code).toBe('not_configured');
  });
});

describe('TavilySearchAdapter', () => {
  const KEY = 'tvly-test-key-0123456789';
  const tavily = (route: Parameters<typeof mockFetch>[0][string], apiKey: string | undefined = KEY) => {
    const m = mockFetch({ 'api.tavily.com': route });
    return { adapter: new TavilySearchAdapter({ apiKey, fetchImpl: m.fetch }), calls: m.calls };
  };
  const tavilyError = (status: number, error: string, headers: Record<string, string> = {}) => () => json({ detail: { error } }, status, headers);

  it('maps results to the web.search contract and sends bearer auth with a basic-depth request', async () => {
    const { adapter, calls } = tavily(() =>
      json({ query: 'q', results: [{ title: 'T', url: 'https://a.com', content: 'snippet text', score: 0.9 }], response_time: 0.4, usage: { credits: 1 }, request_id: 'r' }),
    );
    const res = await adapter.invoke('web.search', { query: 'q', count: 5 }, ctx());
    expect(res.output).toEqual({ results: [{ title: 'T', url: 'https://a.com', snippet: 'snippet text' }] });
    expect(calls[0]!.url).toBe('https://api.tavily.com/search');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ query: 'q', max_results: 5, search_depth: 'basic', topic: 'general', include_answer: false, include_raw_content: false });
    expect(calls[0]!.url).not.toContain(KEY);
  });

  it('returns empty results safely and drops entries without a usable URL', async () => {
    expect((await tavily(() => json({ query: 'q', results: [] })).adapter.invoke('web.search', { query: 'q' }, ctx())).output).toEqual({ results: [] });
    const res = await tavily(() =>
      json({ results: [{ url: 'https://ok.com', title: null, content: null }, { url: 'javascript:alert(1)', title: 'x' }, { url: 'ftp://x', title: 'y' }] }),
    ).adapter.invoke('web.search', { query: 'q' }, ctx());
    expect(res.output).toEqual({ results: [{ title: '', url: 'https://ok.com', snippet: '' }] });
  });

  it('honours Retry-After on 429 and maps 401 to auth_failed', async () => {
    const rl = await providerError(tavily(tavilyError(429, 'Your request has been blocked due to excessive requests.', { 'retry-after': '4' })).adapter.invoke('web.search', { query: 'q' }, ctx()));
    expect(rl).toMatchObject({ code: 'rate_limited', retryable: true, options: { status: 429, retryAfterMs: 4000 } });
    const auth = await providerError(tavily(tavilyError(401, 'Unauthorized: missing or invalid API key.')).adapter.invoke('web.search', { query: 'q' }, ctx()));
    expect(auth).toMatchObject({ code: 'auth_failed', retryable: false });
    expect(auth.message).not.toContain(KEY);
  });

  it('maps 432 (plan limit) and 433 (pay-as-you-go limit) to non-retryable quota_exceeded', async () => {
    for (const status of [432, 433]) {
      const err = await providerError(tavily(tavilyError(status, 'This request exceeds your limit.')).adapter.invoke('web.search', { query: 'q' }, ctx()));
      expect(err).toMatchObject({ code: 'quota_exceeded', retryable: false, options: { status } });
    }
  });

  it('keeps 400/422 as bad_request and 500 as a retryable upstream error', async () => {
    expect((await providerError(tavily(tavilyError(400, 'Invalid topic.')).adapter.invoke('web.search', { query: 'q' }, ctx()))).code).toBe('bad_request');
    expect((await providerError(tavily(() => json({ detail: [{ type: 'x', loc: ['body', 'query'], msg: 'bad' }] }, 422)).adapter.invoke('web.search', { query: 'q' }, ctx()))).code).toBe('bad_request');
    expect((await providerError(tavily(tavilyError(500, 'Internal Server Error')).adapter.invoke('web.search', { query: 'q' }, ctx()))).retryable).toBe(true);
  });

  it('rejects malformed responses', async () => {
    expect((await providerError(tavily(() => json({ results: 'nope' })).adapter.invoke('web.search', { query: 'q' }, ctx()))).code).toBe('malformed_response');
    expect((await providerError(tavily(() => new Response('<html>', { status: 200 })).adapter.invoke('web.search', { query: 'q' }, ctx()))).code).toBe('malformed_response');
  });

  it('times out hung requests', async () => {
    const err = await providerError(tavily(hang).adapter.invoke('web.search', { query: 'q' }, ctx(50)));
    expect(err).toMatchObject({ code: 'timeout', retryable: true });
  });

  it('is disabled without a key and makes no request', async () => {
    // Built directly: passing undefined to the helper would fall back to its default test key.
    const m = mockFetch({ 'api.tavily.com': () => json({ results: [] }) });
    const adapter = new TavilySearchAdapter({ fetchImpl: m.fetch });
    const calls = m.calls;
    expect(adapter.isConfigured()).toBe(false);
    expect((await providerError(adapter.invoke('web.search', { query: 'q' }, ctx()))).code).toBe('not_configured');
    expect(calls).toHaveLength(0);
  });

  it('health check reads GET /usage (no search performed)', async () => {
    const { adapter, calls } = tavily(() => json({ key: { usage: 3, limit: null }, account: { current_plan: 'Researcher' } }));
    await adapter.healthCheck(ctx());
    expect(calls[0]!.url).toBe('https://api.tavily.com/usage');
    expect(calls[0]!.init.method).toBe('GET');
  });
});

describe('ExaSearchAdapter', () => {
  it('maps results and reports provider-supplied cost', async () => {
    const m = mockFetch({
      'api.exa.ai/search': () =>
        json({ requestId: 'r', results: [{ title: null, url: 'https://b.com', highlights: ['h1', 'h2'] }], costDollars: { total: 0.005 } }),
    });
    const res = await new ExaSearchAdapter({ apiKey: 'exa-test-key', fetchImpl: m.fetch }).invoke('web.search', { query: 'q' }, ctx());
    expect(res.output).toEqual({ results: [{ title: '', url: 'https://b.com', snippet: 'h1 … h2' }] });
    expect(res.estimatedCostUsd).toBe(0.005);
    expect(JSON.parse(m.calls[0]!.init.body as string)).toMatchObject({ query: 'q', numResults: 10 });
  });
  it('matches the primary search shape: drops non-http URLs, uses text when highlights are empty', async () => {
    const m = mockFetch({
      'api.exa.ai/search': () =>
        json({ results: [{ title: 'A', url: 'ftp://x', text: 't' }, { title: 'B', url: 'https://c.com', highlights: [], text: 'body' }] }),
    });
    const res = await new ExaSearchAdapter({ apiKey: 'exa-test-key', fetchImpl: m.fetch }).invoke('web.search', { query: 'q' }, ctx());
    expect(res.output).toEqual({ results: [{ title: 'B', url: 'https://c.com', snippet: 'body' }] });
  });
});

describe('GitHubAdapter', () => {
  const repo = {
    full_name: 'o/r', description: null, html_url: 'https://github.com/o/r', default_branch: 'main', stargazers_count: 3,
    forks_count: 1, open_issues_count: 0, language: 'TypeScript', archived: false, pushed_at: null, license: { spdx_id: 'MIT' },
  };
  it('returns normalized repository metadata', async () => {
    const m = mockFetch({ 'api.github.com/repos/o/r': () => json(repo) });
    const res = await new GitHubAdapter({ token: 'ghp_testtoken', fetchImpl: m.fetch }).invoke('github.repo', { owner: 'o', repo: 'r' }, ctx());
    expect(res.output).toMatchObject({ fullName: 'o/r', stars: 3, license: 'MIT' });
  });
  it('maps 404 to not_found (non-retryable)', async () => {
    const m = mockFetch({ 'api.github.com/repos': () => json({ message: 'Not Found' }, 404) });
    const err = await providerError(new GitHubAdapter({ token: 'ghp_testtoken', fetchImpl: m.fetch }).invoke('github.repo', { owner: 'o', repo: 'x' }, ctx()));
    expect(err).toMatchObject({ code: 'not_found', retryable: false });
  });
});

describe('AnthropicAdapter', () => {
  type CreateFn = (...args: unknown[]) => Promise<unknown>;
  const fakeClient = (create: CreateFn) =>
    ({ beta: { messages: { create } }, models: { retrieve: async () => ({}) } }) as unknown as ConstructorParameters<typeof AnthropicAdapter>[0]['client'];
  const make = (create: CreateFn, model = 'claude-opus-5-5') =>
    new AnthropicAdapter({ model, effort: 'medium', maxTokens: 16000, client: fakeClient(create) });

  it('returns text, usage and an estimated cost; sends effort and refusal fallback', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = make(async (body) => {
      sent = body as Record<string, unknown>;
      return {
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        stop_details: null,
        content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hello' }, { type: 'text', text: ' world' }],
        usage: { input_tokens: 1000, output_tokens: 500 },
      };
    });
    const res = await adapter.invoke('llm.generate', { prompt: 'hi', maxTokens: 999_999 }, ctx());
    expect(res.output).toEqual({ text: 'Hello world', model: 'claude-opus-5-5', stopReason: 'end_turn' });
    expect(res.estimatedCostUsd).toBeCloseTo((1000 * 4 + 500 * 20) / 1e6);
    expect(sent).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 16000, output_config: { effort: 'medium' }, fallbacks: 'default' });
    expect(sent.betas).toEqual(['server-side-fallback-2026-07-01']);
  });

  it('does not send server-side fallbacks for models that do not support them', async () => {
    let sent: Record<string, unknown> = {};
    const adapter = make(async (body) => {
      sent = body as Record<string, unknown>;
      return { model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [], usage: { input_tokens: 1, output_tokens: 1 } };
    }, 'claude-haiku-5-5');
    await adapter.invoke('llm.generate', { prompt: 'hi' }, ctx());
    expect(sent.fallbacks).toBeUndefined();
    expect(sent.betas).toBeUndefined();
  });

  it('treats refusals as non-retryable errors instead of returning empty text', async () => {
    const adapter = make(async () => ({
      model: 'claude-opus-5-5', stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [], usage: { input_tokens: 1, output_tokens: 0 },
    }));
    const err = await providerError(adapter.invoke('llm.generate', { prompt: 'x' }, ctx()));
    expect(err).toMatchObject({ code: 'refused', retryable: false });
    expect(err.message).toContain('cyber');
  });

  it('maps SDK errors to normalized codes', async () => {
    const cases: Array<[unknown, string, boolean]> = [
      [Anthropic.APIError.generate(429, {}, 'rate', new Headers({ 'retry-after': '2' })), 'rate_limited', true],
      [Anthropic.APIError.generate(401, {}, 'auth', new Headers()), 'auth_failed', false],
      [Anthropic.APIError.generate(400, {}, 'bad', new Headers()), 'bad_request', false],
      [Anthropic.APIError.generate(529, {}, 'overloaded', new Headers()), 'upstream_error', true],
      [new Anthropic.APIConnectionTimeoutError(), 'timeout', true],
      [new Anthropic.APIConnectionError({ message: 'ECONNRESET' }), 'network_error', true],
    ];
    for (const [thrown, code, retryable] of cases) {
      const err = await providerError(make(async () => { throw thrown; }).invoke('llm.generate', { prompt: 'x' }, ctx()));
      expect({ code: err.code, retryable: err.retryable }).toEqual({ code, retryable });
    }
  });

  it('is not configured without a key', async () => {
    const a = new AnthropicAdapter({ model: 'claude-opus-5-5', effort: 'medium', maxTokens: 100 });
    expect(a.isConfigured()).toBe(false);
    expect((await providerError(a.invoke('llm.generate', { prompt: 'x' }, ctx()))).code).toBe('not_configured');
  });
});
