import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app.js';
import { hashToken } from '../../src/auth/auth.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import type { LookupFn } from '../../src/lib/ssrf.js';
import type { FetchFn } from '../../src/providers/types.js';
import { openDatabase, runMigrations } from '../../src/storage/db.js';

export const TOKENS = {
  admin: 'test-admin-token-0123456789abcdef',
  alice: 'test-alice-token-0123456789abcdef',
  bob: 'test-bob-token-0123456789abcdef00',
};

export const authHeader = (who: keyof typeof TOKENS) => ({ authorization: `Bearer ${TOKENS[who]}` });

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    AUTH_TOKENS: [
      `admin:admin:${hashToken(TOKENS.admin)}`,
      `alice:user:${hashToken(TOKENS.alice)}`,
      `bob:user:${hashToken(TOKENS.bob)}`,
    ].join(','),
    ENABLE_MOCK_PROVIDERS: 'true',
    PROVIDER_MAX_RETRIES: '1',
    ...overrides,
  });
}

/** Public-looking DNS for SSRF checks in tests (no real lookups). */
export const publicLookup: LookupFn = async () => [{ address: '93.184.215.14', family: 4 }];

export async function testApp(
  opts: { env?: Record<string, string>; fetchImpl?: FetchFn; lookup?: LookupFn } = {},
): Promise<FastifyInstance> {
  const db = openDatabase(':memory:');
  runMigrations(db);
  const app = await buildApp({
    env: testEnv(opts.env),
    db,
    fetchImpl: opts.fetchImpl ?? (async (u) => {
      throw new Error(`Unexpected fetch in test: ${String(u)}`);
    }),
    lookup: opts.lookup ?? publicLookup,
    sleep: async () => {}, // no real backoff delays in tests
  });
  await app.ready();
  return app;
}
