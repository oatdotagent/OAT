import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerSecrets } from '../../src/lib/redact.js';
import { authHeader, testApp } from '../helpers/app.js';
import { hang, json, mockFetch } from '../helpers/fetch.js';

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

const researchWorkflow = {
  name: 'Research brief',
  inputSchema: { type: 'object', required: ['topic'], properties: { topic: { type: 'string', minLength: 2 } }, additionalProperties: false },
  steps: [
    { id: 'search', capability: 'web.search', input: { query: '{{input.topic}}', count: 2 }, verification: { criteria: [{ type: 'min_items', path: 'results', min: 1 }] } },
    { id: 'repo', capability: 'github.repo', input: { owner: 'octo', repo: 'demo' } },
    {
      id: 'summary',
      capability: 'llm.generate',
      dependsOn: ['search', 'repo'],
      input: { prompt: 'Summarize {{input.topic}} citing {{steps.search.output.results[0].url}}' },
      verification: {
        schema: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 1 } } },
        criteria: [{ type: 'urls_in_step', path: 'text', sourceStep: 'search' }],
      },
    },
  ],
};

async function createWorkflow(def: unknown, who: 'alice' | 'bob' | 'admin' = 'alice') {
  const res = await app.inject({ method: 'POST', url: '/api/v1/workflows', headers: authHeader(who), payload: def as object });
  return res;
}

async function runToCompletion(workflowId: string, input: unknown, who: 'alice' | 'bob' | 'admin' = 'alice') {
  const start = await app.inject({ method: 'POST', url: `/api/v1/workflows/${workflowId}/executions`, headers: authHeader(who), payload: { input } });
  expect(start.statusCode).toBe(202);
  const id = start.json().data.id as string;
  await app.coordinator.whenSettled(id);
  const res = await app.inject({ method: 'GET', url: `/api/v1/executions/${id}`, headers: authHeader(who) });
  return res.json().data;
}

describe('workflows and executions', () => {
  it('rejects invalid definitions with 422 and field-level errors', async () => {
    app = await testApp();
    const res = await createWorkflow({ name: 'bad', steps: [{ id: 'a', capability: 'web.search', input: {}, dependsOn: ['a'] }] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'invalid_workflow', details: [{ message: 'a step cannot depend on itself' }] });
  });

  it('validates drafts without saving and reports stages + readiness', async () => {
    app = await testApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/workflows/validate', headers: authHeader('alice'), payload: researchWorkflow });
    expect(res.json().data).toMatchObject({ valid: true, stages: [['search', 'repo'], ['summary']] });
    expect(res.json().data.readiness.every((r: { ready: boolean }) => r.ready)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/v1/workflows', headers: authHeader('alice') })).json().meta.page.total).toBe(0);
  });

  it('scopes workflows to their owner (404 for others, visible to admin)', async () => {
    app = await testApp();
    const created = await createWorkflow(researchWorkflow);
    expect(created.statusCode).toBe(201);
    const id = created.json().data.id;
    expect((await app.inject({ method: 'GET', url: `/api/v1/workflows/${id}`, headers: authHeader('bob') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v1/workflows/${id}`, headers: authHeader('admin') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/workflows', headers: authHeader('bob') })).json().data).toHaveLength(0);
    expect((await app.inject({ method: 'POST', url: `/api/v1/workflows/${id}/executions`, headers: authHeader('bob'), payload: { input: { topic: 'x' } } })).statusCode).toBe(404);
  });

  it('runs a parallel + dependent workflow on MOCK providers and records verification honestly', async () => {
    app = await testApp();
    const wf = (await createWorkflow(researchWorkflow)).json().data;
    const ex = await runToCompletion(wf.id, { topic: 'vector databases' });

    expect(ex.status).toBe('succeeded');
    expect(ex.steps.map((s: { stepId: string; status: string; provider: string; isMock: boolean }) => [s.stepId, s.status, s.provider, s.isMock])).toEqual([
      ['search', 'succeeded', 'mock', true],
      ['repo', 'succeeded', 'mock', true],
      ['summary', 'succeeded', 'mock', true],
    ]);
    const summary = ex.steps.find((s: { stepId: string }) => s.stepId === 'summary');
    expect(summary.output.text).toContain('https://example.com/mock/1');

    const v = await app.inject({ method: 'GET', url: `/api/v1/verifications/${summary.verificationId}`, headers: authHeader('alice') });
    expect(v.statusCode).toBe(200);
    expect(v.json().data).toMatchObject({
      status: 'passed',
      assessment: { isMock: true, factualClaimsVerified: false, groundingStatus: 'citations_traced', contentSource: 'model_generated' },
    });
    // Other users cannot read the verification or execution.
    expect((await app.inject({ method: 'GET', url: `/api/v1/verifications/${summary.verificationId}`, headers: authHeader('bob') })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/v1/executions/${ex.id}`, headers: authHeader('bob') })).statusCode).toBe(404);

    const list = await app.inject({ method: 'GET', url: `/api/v1/executions?workflowId=${wf.id}`, headers: authHeader('alice') });
    expect(list.json().data).toHaveLength(1);
    expect(list.json().data[0].input).toBeUndefined();
  });

  it('validates execution input against the workflow inputSchema', async () => {
    app = await testApp();
    const wf = (await createWorkflow(researchWorkflow)).json().data;
    const res = await app.inject({ method: 'POST', url: `/api/v1/workflows/${wf.id}/executions`, headers: authHeader('alice'), payload: { input: { topic: 1, extra: true } } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('invalid_input');

    const check = await app.inject({ method: 'POST', url: `/api/v1/workflows/${wf.id}/validate`, headers: authHeader('alice'), payload: { input: { topic: 'ok' } } });
    expect(check.json().data).toMatchObject({ valid: true, executable: true, input: { ok: true } });
  });

  it('refuses to start when a step has no configured provider', async () => {
    app = await testApp({ env: { ENABLE_MOCK_PROVIDERS: 'false' } });
    const wf = (await createWorkflow(researchWorkflow)).json().data;
    const res = await app.inject({ method: 'POST', url: `/api/v1/workflows/${wf.id}/executions`, headers: authHeader('alice'), payload: { input: { topic: 'xx' } } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('providers_unavailable');
  });

  it('enforces per-capability permissions for non-admin users', async () => {
    app = await testApp({ env: { USER_ALLOWED_CAPABILITIES: 'web.search' } });
    const res = await createWorkflow(researchWorkflow);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.details.map((d: { capability: string }) => d.capability)).toEqual(['github.repo', 'llm.generate']);
    expect((await createWorkflow(researchWorkflow, 'admin')).statusCode).toBe(201);
  });

  it('retries, falls back between real adapters, and records provider metrics', async () => {
    const tavily = mockFetch({ 'api.tavily.com': () => json({ detail: { error: 'Internal Server Error' } }, 503) });
    const exa = mockFetch({ 'api.exa.ai/search': () => json({ results: [{ title: 'E', url: 'https://exa.example/a', highlights: ['h'] }], costDollars: { total: 0.01 } }) });
    const fetchImpl: typeof fetch = (input, init) => (String(input).includes('tavily') ? tavily.fetch(input, init) : exa.fetch(input, init));
    app = await testApp({ env: { ENABLE_MOCK_PROVIDERS: 'false', TAVILY_API_KEY: 'tvly-test-key-0123', EXA_API_KEY: 'exa-test-key' }, fetchImpl });

    const wf = (await createWorkflow({ name: 'search', steps: [{ id: 's', capability: 'web.search', input: { query: 'x' } }] })).json().data;
    const ex = await runToCompletion(wf.id, {});
    expect(ex.status).toBe('succeeded');
    expect(ex.steps[0]).toMatchObject({ provider: 'exa', attempts: 1, fallbackFrom: ['tavily'] });
    expect(tavily.calls).toHaveLength(2); // 1 try + 1 retry (PROVIDER_MAX_RETRIES=1 in tests)

    const metrics = (await app.inject({ method: 'GET', url: '/api/v1/metrics', headers: authHeader('admin') })).json().data;
    expect(metrics.providers.byCapability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'tavily', calls: 1, errors: 1, attempts: 2 }),
        expect.objectContaining({ provider: 'exa', calls: 1, errors: 0, estimatedCostUsd: 0.01 }),
      ]),
    );
    expect(metrics.providers.errors).toEqual([{ provider: 'tavily', code: 'upstream_error', count: 1 }]);
  });

  it('runs llm.generate through the Gemini adapter end to end (mocked HTTP)', async () => {
    const gemini = mockFetch({
      'generativelanguage.googleapis.com': () =>
        json({ candidates: [{ content: { parts: [{ text: 'OAT is ready.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 }, modelVersion: 'gemini-3.6-flash' }),
    });
    app = await testApp({ env: { ENABLE_MOCK_PROVIDERS: 'false', PROVIDER_ROUTING: 'llm.generate=gemini', GEMINI_API_KEY: 'gemini-test-key-0123456789' }, fetchImpl: gemini.fetch });

    const providers = (await app.inject({ method: 'GET', url: '/api/v1/providers', headers: authHeader('alice') })).json().data;
    expect(providers.providers.find((p: { id: string }) => p.id === 'gemini')).toMatchObject({ configured: true, displayName: 'Google Gemini' });
    expect(providers.capabilities.find((c: { name: string }) => c.name === 'llm.generate')).toMatchObject({ available: true, providers: ['gemini'] });
    expect(JSON.stringify(providers)).not.toContain('gemini-test-key-0123456789');

    const wf = (await createWorkflow({ name: 'llm', steps: [{ id: 'g', capability: 'llm.generate', input: { prompt: 'Say hi' }, verification: { criteria: [{ type: 'string_length', path: 'text', min: 1 }] } }] })).json().data;
    const ex = await runToCompletion(wf.id, {});
    expect(ex.status).toBe('succeeded');
    expect(ex.steps[0]).toMatchObject({ provider: 'gemini', isMock: false, attempts: 1, output: { text: 'OAT is ready.', stopReason: 'STOP' } });

    const metrics = (await app.inject({ method: 'GET', url: '/api/v1/metrics', headers: authHeader('admin') })).json().data;
    expect(metrics.providers.byCapability).toEqual([expect.objectContaining({ provider: 'gemini', capability: 'llm.generate', calls: 1, errors: 0, totalTokens: 9, estimatedCostUsd: null })]);
  });

  it('with Gemini routed but GEMINI_API_KEY empty, llm.generate is unavailable — no silent fallback to Anthropic or mock', async () => {
    // Anthropic configured and mock enabled are both tempting substitutes; neither may be used.
    app = await testApp({ env: { ENABLE_MOCK_PROVIDERS: 'true', PROVIDER_ROUTING: 'llm.generate=gemini', ANTHROPIC_API_KEY: 'sk-ant-test-0123456789' } });

    const res = await app.inject({ method: 'GET', url: '/api/v1/providers', headers: authHeader('alice') });
    const data = res.json().data;
    expect(data.providers.find((p: { id: string }) => p.id === 'gemini')).toMatchObject({
      configured: false,
      unavailableReason: 'Google Gemini is disabled: GEMINI_API_KEY is not set',
      health: { status: 'disabled' },
    });
    const llm = data.capabilities.find((c: { name: string }) => c.name === 'llm.generate');
    expect(llm).toMatchObject({ available: false, providers: [], routedTo: ['gemini'] });
    expect(llm.unavailableReason).toContain('GEMINI_API_KEY is not set');
    expect(res.body).not.toContain('sk-ant-test-0123456789');
    // Other capabilities are unaffected by the llm.generate routing.
    expect(data.capabilities.find((c: { name: string }) => c.name === 'web.search')).toMatchObject({ available: true, routedTo: null });

    const wf = (await createWorkflow({ name: 'llm', steps: [{ id: 'g', capability: 'llm.generate', input: { prompt: 'hi' } }] })).json().data;
    const check = (await app.inject({ method: 'POST', url: `/api/v1/workflows/${wf.id}/validate`, headers: authHeader('alice'), payload: {} })).json().data;
    expect(check).toMatchObject({ valid: true, executable: false, readiness: [{ stepId: 'g', ready: false }] });
    expect(check.readiness[0].reason).toContain('GEMINI_API_KEY is not set');

    const start = await app.inject({ method: 'POST', url: `/api/v1/workflows/${wf.id}/executions`, headers: authHeader('alice'), payload: {} });
    expect(start.statusCode).toBe(409);
    expect(start.json().error).toMatchObject({ code: 'providers_unavailable' });
    expect(start.json().error.details[0].message).toContain('GEMINI_API_KEY is not set');
    expect((await app.inject({ method: 'GET', url: '/api/v1/executions', headers: authHeader('alice') })).json().data).toHaveLength(0);
  });

  it('refuses to start when PROVIDER_ROUTING names an unknown provider', async () => {
    await expect(testApp({ env: { PROVIDER_ROUTING: 'llm.generate=gemnii' } })).rejects.toThrow(/unknown provider "gemnii"/);
  });

  it('falls back from Tavily to Exa when the Tavily key is rejected or its credit limit is reached (no retries)', async () => {
    const exaOk = () => json({ results: [{ title: 'E', url: 'https://exa.example/a', highlights: ['h'] }], costDollars: { total: 0.005 } });
    for (const tavilyFailure of [
      () => json({ detail: { error: 'Unauthorized: missing or invalid API key.' } }, 401),
      () => json({ detail: { error: "This request exceeds your plan's set usage limit." } }, 432),
      () => json({ detail: { error: 'This request exceeds the pay-as-you-go limit.' } }, 433),
    ]) {
      const tavily = mockFetch({ 'api.tavily.com': tavilyFailure });
      const exa = mockFetch({ 'api.exa.ai/search': exaOk });
      const fetchImpl: typeof fetch = (input, init) => (String(input).includes('tavily') ? tavily.fetch(input, init) : exa.fetch(input, init));
      app = await testApp({ env: { ENABLE_MOCK_PROVIDERS: 'false', TAVILY_API_KEY: 'tvly-test-key-0123', EXA_API_KEY: 'exa-test-key' }, fetchImpl });
      const wf = (await createWorkflow({ name: 'search', steps: [{ id: 's', capability: 'web.search', input: { query: 'x' } }] })).json().data;
      const ex = await runToCompletion(wf.id, {});
      expect(ex.status).toBe('succeeded');
      expect(ex.steps[0]).toMatchObject({ provider: 'exa', fallbackFrom: ['tavily'] });
      expect(tavily.calls).toHaveLength(1); // auth and quota failures are not retried
      await app.close();
    }
  });

  it('reports web.search as unavailable with the missing settings when neither Tavily nor Exa is configured', async () => {
    app = await testApp({ env: { ENABLE_MOCK_PROVIDERS: 'false' } });
    const caps = (await app.inject({ method: 'GET', url: '/api/v1/providers', headers: authHeader('alice') })).json().data.capabilities;
    expect(caps.find((c: { name: string }) => c.name === 'web.search')).toMatchObject({
      available: false,
      providers: [],
      unavailableReason: 'No configured provider offers web.search. Set one of: TAVILY_API_KEY, EXA_API_KEY',
    });
  });

  it('fails the step on malformed responses, skips dependents, and honours continueOnError', async () => {
    const f = mockFetch({ 'api.tavily.com': () => json({ results: [{ title: 1 }] }) });
    app = await testApp({ env: { TAVILY_API_KEY: 'tvly-test-key-0123', PROVIDER_FALLBACK_ENABLED: 'false' }, fetchImpl: f.fetch });
    const wf = (
      await createWorkflow({
        name: 'x',
        steps: [
          { id: 'search', capability: 'web.search', provider: 'tavily', input: { query: 'x' }, continueOnError: true },
          { id: 'use', capability: 'llm.generate', dependsOn: ['search'], input: { prompt: '{{steps.search.output.results[0].url}}' }, continueOnError: true },
          { id: 'independent', capability: 'llm.generate', input: { prompt: 'hello' } },
        ],
      })
    ).json().data;
    const ex = await runToCompletion(wf.id, {});
    const byId = Object.fromEntries(ex.steps.map((s: { stepId: string }) => [s.stepId, s]));
    expect(byId.search).toMatchObject({ status: 'failed', error: { code: 'malformed_response', provider: 'tavily' } });
    expect(byId.use).toMatchObject({ status: 'skipped', error: { code: 'dependency_failed' } });
    expect(byId.independent.status).toBe('succeeded');
    expect(ex.status).toBe('succeeded'); // all failures were continueOnError
  });

  it('fails the execution when a required verification does not pass', async () => {
    app = await testApp();
    const wf = (
      await createWorkflow({
        name: 'strict',
        steps: [{ id: 'g', capability: 'llm.generate', input: { prompt: 'x' }, verification: { required: true, criteria: [{ type: 'contains', path: 'text', value: 'never-present' }] } }],
      })
    ).json().data;
    const ex = await runToCompletion(wf.id, {});
    expect(ex.status).toBe('failed');
    expect(ex.steps[0]).toMatchObject({ status: 'failed', error: { code: 'verification_failed' }, verificationId: expect.stringMatching(/^vf_/) });
  });

  it('blocks SSRF targets in web.extract steps', async () => {
    app = await testApp();
    const wf = (await createWorkflow({ name: 'ssrf', steps: [{ id: 'x', capability: 'web.extract', input: { url: '{{input.url}}' } }] })).json().data;
    const ex = await runToCompletion(wf.id, { url: 'http://169.254.169.254/latest/meta-data/' });
    expect(ex.status).toBe('failed');
    expect(ex.steps[0].error).toMatchObject({ code: 'blocked_url' });
  });

  it('redacts secrets that providers echo back in errors before persisting them', async () => {
    registerSecrets(['tvly-echoed-secret-key']);
    const f = mockFetch({ 'api.tavily.com': () => json({ detail: { error: 'invalid API key tvly-echoed-secret-key' } }, 401) });
    app = await testApp({ env: { TAVILY_API_KEY: 'tvly-echoed-secret-key', ENABLE_MOCK_PROVIDERS: 'false' }, fetchImpl: f.fetch });
    const wf = (await createWorkflow({ name: 'r', steps: [{ id: 's', capability: 'web.search', input: { query: 'x' } }] })).json().data;
    const start = await app.inject({ method: 'POST', url: `/api/v1/workflows/${wf.id}/executions`, headers: authHeader('alice'), payload: {} });
    await app.coordinator.whenSettled(start.json().data.id);
    const res = await app.inject({ method: 'GET', url: `/api/v1/executions/${start.json().data.id}`, headers: authHeader('alice') });
    expect(res.json().data.steps[0].error.code).toBe('auth_failed');
    expect(res.body).not.toContain('tvly-echoed-secret-key');
  });

  it('cancels a running execution', async () => {
    const f = mockFetch({ 'api.tavily.com': hang });
    app = await testApp({ env: { TAVILY_API_KEY: 'tvly-test-key-0123', ENABLE_MOCK_PROVIDERS: 'false' }, fetchImpl: f.fetch });
    const wf = (await createWorkflow({ name: 'slow', steps: [{ id: 's', capability: 'web.search', input: { query: 'x' } }, { id: 't', capability: 'web.search', dependsOn: ['s'], input: { query: 'y' } }] })).json().data;
    const start = await app.inject({ method: 'POST', url: `/api/v1/workflows/${wf.id}/executions`, headers: authHeader('alice'), payload: {} });
    const id = start.json().data.id;
    await new Promise((r) => setTimeout(r, 20));
    const cancel = await app.inject({ method: 'POST', url: `/api/v1/executions/${id}/cancel`, headers: authHeader('alice') });
    expect(cancel.statusCode).toBe(202);
    await app.coordinator.whenSettled(id);
    const ex = (await app.inject({ method: 'GET', url: `/api/v1/executions/${id}`, headers: authHeader('alice') })).json().data;
    expect(ex.status).toBe('cancelled');
    // The in-flight step is aborted; the never-started dependent is cancelled too.
    expect(ex.steps.map((s: { status: string }) => s.status)).toEqual(['cancelled', 'cancelled']);
    expect((await app.inject({ method: 'POST', url: `/api/v1/executions/${id}/cancel`, headers: authHeader('alice') })).statusCode).toBe(409);
  });

  it('times out executions that exceed EXECUTION_TIMEOUT_MS', async () => {
    const f = mockFetch({ 'api.tavily.com': hang });
    app = await testApp({ env: { TAVILY_API_KEY: 'tvly-test-key-0123', ENABLE_MOCK_PROVIDERS: 'false', EXECUTION_TIMEOUT_MS: '5000', PROVIDER_TIMEOUT_MS: '60000' }, fetchImpl: f.fetch });
    const wf = (await createWorkflow({ name: 'slow', steps: [{ id: 's', capability: 'web.search', input: { query: 'x' } }] })).json().data;
    const ex = await runToCompletion(wf.id, {});
    expect(ex.status).toBe('failed');
    expect(ex.error).toMatchObject({ code: 'execution_timeout' });
  }, 15_000);

  describe('editing and deleting', () => {
    const search = { id: 's', capability: 'web.search', input: { query: 'x' } };
    const put = (id: string, def: unknown, who: 'alice' | 'bob' | 'admin' = 'alice') =>
      app.inject({ method: 'PUT', url: `/api/v1/workflows/${id}`, headers: authHeader(who), payload: def as object });
    const del = (id: string, who: 'alice' | 'bob' | 'admin' = 'alice') =>
      app.inject({ method: 'DELETE', url: `/api/v1/workflows/${id}`, headers: authHeader(who) });
    const get = (url: string, who: 'alice' | 'bob' | 'admin' = 'alice') => app.inject({ method: 'GET', url, headers: authHeader(who) });

    it('updates a workflow and bumps its version; past executions keep the version they ran', async () => {
      app = await testApp();
      const wf = (await createWorkflow({ name: 'first', steps: [search] })).json().data;
      const before = await runToCompletion(wf.id, {});
      expect(before.workflowVersion).toBe(1);

      const res = await put(wf.id, { name: 'second', description: 'renamed', steps: [search] });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ id: wf.id, name: 'second', description: 'renamed', version: 2, stages: [['s']] });

      const after = await runToCompletion(wf.id, {});
      expect(after.workflowVersion).toBe(2);
      expect((await get(`/api/v1/executions/${before.id}`)).json().data.workflowVersion).toBe(1);
    });

    it('rejects an invalid update and leaves the workflow unchanged', async () => {
      app = await testApp();
      const wf = (await createWorkflow({ name: 'keep', steps: [search] })).json().data;
      const res = await put(wf.id, { name: 'bad', steps: [{ ...search, dependsOn: ['s'] }] });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('invalid_workflow');
      expect((await get(`/api/v1/workflows/${wf.id}`)).json().data).toMatchObject({ name: 'keep', version: 1 });
    });

    it('refuses an update that adds a capability the caller may not use', async () => {
      app = await testApp({ env: { USER_ALLOWED_CAPABILITIES: 'web.search' } });
      const wf = (await createWorkflow({ name: 'limited', steps: [search] })).json().data;
      const res = await put(wf.id, { name: 'limited', steps: [{ id: 'g', capability: 'llm.generate', input: { prompt: 'hi' } }] });
      expect(res.statusCode).toBe(403);
      expect((await get(`/api/v1/workflows/${wf.id}`)).json().data.version).toBe(1);
    });

    it("hides other users' workflows from update and delete, but allows admins", async () => {
      app = await testApp();
      const wf = (await createWorkflow({ name: 'mine', steps: [search] })).json().data;
      expect((await put(wf.id, { name: 'theirs', steps: [search] }, 'bob')).statusCode).toBe(404);
      expect((await del(wf.id, 'bob')).statusCode).toBe(404);
      expect((await get(`/api/v1/workflows/${wf.id}`)).json().data.name).toBe('mine');
      expect((await put(wf.id, { name: 'by admin', steps: [search] }, 'admin')).json().data.version).toBe(2);
      expect((await del(wf.id, 'admin')).statusCode).toBe(200);
    });

    it('deletes a workflow with its executions and verifications, keeping statistics and the audit trail', async () => {
      app = await testApp({ fetchImpl: mockFetch({}).fetch });
      const wf = (await createWorkflow(researchWorkflow)).json().data;
      const ex = await runToCompletion(wf.id, { topic: 'agents' });
      const verificationId = ex.steps.find((s: { verificationId?: string }) => s.verificationId).verificationId;

      const res = await del(wf.id);
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ id: wf.id, deleted: true, executionsDeleted: 1 });

      expect((await get(`/api/v1/workflows/${wf.id}`)).statusCode).toBe(404);
      expect((await get(`/api/v1/executions/${ex.id}`)).statusCode).toBe(404);
      expect((await get(`/api/v1/verifications/${verificationId}`)).statusCode).toBe(404);
      expect((await del(wf.id)).statusCode).toBe(404);

      const metrics = (await get('/api/v1/metrics', 'admin')).json().data;
      expect(metrics.providers.byCapability.length).toBeGreaterThan(0);
      const audit = (await get('/api/v1/audit-events', 'admin')).json().data;
      expect(audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'workflow.delete', resourceId: wf.id, outcome: 'success' })]));
    });

    it('refuses to delete a workflow while a run is active', async () => {
      const f = mockFetch({ 'api.tavily.com': hang });
      app = await testApp({ env: { TAVILY_API_KEY: 'tvly-test-key-0123', ENABLE_MOCK_PROVIDERS: 'false' }, fetchImpl: f.fetch });
      const wf = (await createWorkflow({ name: 'slow', steps: [search] })).json().data;
      const start = await app.inject({ method: 'POST', url: `/api/v1/workflows/${wf.id}/executions`, headers: authHeader('alice'), payload: {} });
      const id = start.json().data.id;
      await new Promise((r) => setTimeout(r, 20));

      const refused = await del(wf.id);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('conflict');
      expect((await get(`/api/v1/workflows/${wf.id}`)).statusCode).toBe(200);

      await app.inject({ method: 'POST', url: `/api/v1/executions/${id}/cancel`, headers: authHeader('alice') });
      await app.coordinator.whenSettled(id);
      expect((await del(wf.id)).statusCode).toBe(200);
    });
  });
});
