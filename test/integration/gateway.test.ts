import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { authHeader, testApp } from '../helpers/app.js';

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

describe('gateway: health, auth, envelopes, limits', () => {
  it('serves public liveness/readiness without leaking configuration', async () => {
    app = await testApp();
    const live = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ data: { status: 'ok' }, meta: { requestId: expect.any(String) } });
    const ready = await app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().data).toEqual({ status: 'ready', checks: { database: { ok: true }, migrations: { ok: true } } });
  });

  it('requires authentication and rejects bad tokens uniformly', async () => {
    app = await testApp();
    const none = await app.inject({ method: 'GET', url: '/api/v1/workflows' });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({ error: { code: 'unauthorized' }, meta: { requestId: expect.any(String) } });
    const bad = await app.inject({ method: 'GET', url: '/api/v1/workflows', headers: { authorization: 'Bearer wrong-token-0123456789' } });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/api/v1/workflows', headers: authHeader('alice') });
    expect(ok.statusCode).toBe(200);
  });

  it('enforces role permissions on admin routes and audits denials', async () => {
    app = await testApp();
    expect((await app.inject({ method: 'GET', url: '/api/v1/metrics', headers: authHeader('alice') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/providers/health/probe', headers: authHeader('alice') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/metrics', headers: authHeader('admin') })).statusCode).toBe(200);
    const audit = await app.inject({ method: 'GET', url: '/api/v1/audit-events', headers: authHeader('admin') });
    expect(audit.json().data.filter((e: { action: string }) => e.action === 'authz.denied')).toHaveLength(2);
  });

  it('supports a development bypass only when no tokens are configured', async () => {
    app = await testApp({ env: { AUTH_TOKENS: '', AUTH_DEV_BYPASS: 'true' } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/metrics' })).statusCode).toBe(200);
  });

  it('echoes valid request IDs and replaces unsafe ones', async () => {
    app = await testApp();
    const good = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { 'x-request-id': 'client-req-12345' } });
    expect(good.headers['x-request-id']).toBe('client-req-12345');
    const evil = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { 'x-request-id': 'bad id\r\ninjected' } });
    expect(evil.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects oversized, malformed and non-JSON bodies', async () => {
    app = await testApp({ env: { BODY_LIMIT_BYTES: '2048' } });
    const big = await app.inject({ method: 'POST', url: '/api/v1/workflows', headers: { ...authHeader('alice'), 'content-type': 'application/json' }, payload: JSON.stringify({ name: 'x'.repeat(5000) }) });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('payload_too_large');
    const malformed = await app.inject({ method: 'POST', url: '/api/v1/workflows', headers: { ...authHeader('alice'), 'content-type': 'application/json' }, payload: '{"name":' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('invalid_json');
    const text = await app.inject({ method: 'POST', url: '/api/v1/workflows', headers: { ...authHeader('alice'), 'content-type': 'text/plain' }, payload: 'hi' });
    expect(text.statusCode).toBe(415);
  });

  it('rate limits per credential with the standard error envelope', async () => {
    app = await testApp({ env: { RATE_LIMIT_MAX: '3' } });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await app.inject({ method: 'GET', url: '/api/v1/workflows', headers: authHeader('alice') })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429]);
    const limited = await app.inject({ method: 'GET', url: '/api/v1/workflows', headers: authHeader('alice') });
    expect(limited.json()).toMatchObject({ error: { code: 'rate_limited' } });
    // A different credential has its own bucket.
    expect((await app.inject({ method: 'GET', url: '/api/v1/workflows', headers: authHeader('bob') })).statusCode).toBe(200);
  });

  it('applies CORS only to configured origins', async () => {
    app = await testApp({ env: { CORS_ORIGINS: 'https://app.example.com' } });
    const allowed = await app.inject({ method: 'OPTIONS', url: '/api/v1/workflows', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' } });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.com');
    const denied = await app.inject({ method: 'OPTIONS', url: '/api/v1/workflows', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns JSON 404s for unknown routes and invalid ids', async () => {
    app = await testApp();
    expect((await app.inject({ method: 'GET', url: '/api/v2/anything' })).json()).toMatchObject({ error: { code: 'not_found' } });
    const badId = await app.inject({ method: 'GET', url: '/api/v1/workflows/not-an-id', headers: authHeader('alice') });
    expect(badId.statusCode).toBe(400);
    expect(badId.json().error.code).toBe('validation_error');
  });

  it('lists providers and capabilities without exposing secrets', async () => {
    app = await testApp({ env: { TAVILY_API_KEY: 'tvly-secret-value-xyz', ENABLE_MOCK_PROVIDERS: 'false' } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/providers', headers: authHeader('alice') });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('tvly-secret-value-xyz');
    const body = res.json().data;
    const tavily = body.providers.find((p: { id: string }) => p.id === 'tavily');
    expect(tavily).toMatchObject({ configured: true, displayName: 'Tavily', health: { status: 'unknown', probe: 'active' } });
    expect(body.providers.some((p: { id: string }) => p.id === 'brave')).toBe(false);
    expect(body.providers.find((p: { id: string }) => p.id === 'anthropic').configured).toBe(false);
    const search = body.capabilities.find((c: { name: string }) => c.name === 'web.search');
    expect(search).toMatchObject({ available: true, providers: ['tavily'], fallbackCompatible: true });
    expect(search.inputSchema).toMatchObject({ type: 'object' });
    expect(body.capabilities.find((c: { name: string }) => c.name === 'llm.generate').available).toBe(false);
  });
});
