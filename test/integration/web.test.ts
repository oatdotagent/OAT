import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, testApp } from '../helpers/app.js';

let app: FastifyInstance;
let webDir: string;

beforeAll(() => {
  // A stand-in build output so these tests don't depend on running `vite build` first.
  webDir = mkdtempSync(join(tmpdir(), 'oat-web-'));
  mkdirSync(join(webDir, 'assets'));
  mkdirSync(join(webDir, 'console'));
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>landing</title>');
  writeFileSync(join(webDir, 'console', 'index.html'), '<!doctype html><title>console</title>');
  writeFileSync(join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(webDir, '.env'), 'SECRET=1');
});
afterAll(() => rmSync(webDir, { recursive: true, force: true }));
afterEach(async () => {
  await app?.close();
});

describe('GET /api/v1/me', () => {
  it('returns identity and permissions without credentials', async () => {
    app = await testApp();
    const user = await app.inject({ method: 'GET', url: '/api/v1/me', headers: authHeader('alice') });
    expect(user.json().data).toEqual({
      userId: 'alice',
      role: 'user',
      devBypass: false,
      permissions: ['workflows:read', 'workflows:write', 'executions:read', 'executions:run', 'executions:cancel', 'verifications:read', 'providers:read'],
    });
    const admin = await app.inject({ method: 'GET', url: '/api/v1/me', headers: authHeader('admin') });
    expect(admin.json().data.permissions).toContain('metrics:read');
    expect((await app.inject({ method: 'GET', url: '/api/v1/me' })).statusCode).toBe(401);
  });
});

describe('static frontend', () => {
  it('serves the landing page and console with a strict CSP', async () => {
    app = await testApp({ env: { WEB_DIST_DIR: webDir } });
    const landing = await app.inject({ method: 'GET', url: '/' });
    expect(landing.statusCode).toBe(200);
    expect(landing.body).toContain('landing');
    const csp = landing.headers['content-security-policy'] as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('upgrade-insecure-requests'); // dev/test serve plain HTTP
    expect(landing.headers['cache-control']).toBe('no-cache');

    const consolePage = await app.inject({ method: 'GET', url: '/console/' });
    expect(consolePage.statusCode).toBe(200);
    expect(consolePage.body).toContain('console');
  });

  it('caches hashed assets immutably and keeps API responses uncached', async () => {
    app = await testApp({ env: { WEB_DIST_DIR: webDir } });
    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const api = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(api.headers['cache-control']).toBe('no-store');
  });

  it('does not serve dotfiles or escape the web root', async () => {
    app = await testApp({ env: { WEB_DIST_DIR: webDir } });
    for (const url of ['/.env', '/../package.json', '/%2e%2e/package.json', '/assets/..%2f..%2fpackage.json']) {
      const res = await app.inject({ method: 'GET', url });
      expect([403, 404]).toContain(res.statusCode);
      expect(res.body).not.toContain('SECRET=1');
      expect(res.body).not.toContain('oat-agent-infra-backend');
    }
  });

  it('does not rate limit static assets but still limits the API', async () => {
    app = await testApp({ env: { WEB_DIST_DIR: webDir, RATE_LIMIT_MAX: '2' } });
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'GET', url: '/assets/app-abc123.js' })).statusCode).toBe(200);
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject({ method: 'GET', url: '/api/v1/workflows', headers: authHeader('bob') })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
  });

  it('keeps unknown API routes as JSON 404s when the frontend is mounted', async () => {
    app = await testApp({ env: { WEB_DIST_DIR: webDir } });
    const res = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('skips static serving when the build is absent or disabled', async () => {
    app = await testApp({ env: { WEB_DIST_DIR: join(webDir, 'missing') } });
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    await app.close();
    app = await testApp({ env: { WEB_DIST_DIR: webDir, SERVE_WEB: 'false' } });
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });
});
