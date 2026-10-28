import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv } from '../../src/config/env.js';

const HASH = 'a'.repeat(64);

describe('loadEnv', () => {
  it('applies safe defaults and leaves every provider unconfigured', () => {
    const env = loadEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.ENABLE_MOCK_PROVIDERS).toBe(false);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CORS_ORIGINS).toEqual([]);
  });

  it('treats empty strings as unset', () => {
    const env = loadEnv({ ANTHROPIC_API_KEY: '', PORT: '' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PORT).toBe(3000);
  });

  it('rejects raw tokens in AUTH_TOKENS (hashes only)', () => {
    expect(() => loadEnv({ AUTH_TOKENS: 'alice:user:my-plain-token' })).toThrow(EnvValidationError);
    expect(loadEnv({ AUTH_TOKENS: `alice:user:${HASH}` }).AUTH_TOKENS).toHaveLength(1);
  });

  it('enforces production safety rules', () => {
    const err = (() => {
      try {
        loadEnv({ NODE_ENV: 'production', AUTH_DEV_BYPASS: 'true', ENABLE_MOCK_PROVIDERS: 'true' });
      } catch (e) {
        return e as EnvValidationError;
      }
    })();
    expect(err).toBeInstanceOf(EnvValidationError);
    const text = err!.issues.join('\n');
    expect(text).toMatch(/AUTH_TOKENS: required in production/);
    expect(text).toMatch(/AUTH_DEV_BYPASS/);
    expect(text).toMatch(/ENABLE_MOCK_PROVIDERS/);
  });

  it('rejects wildcard and malformed CORS origins', () => {
    expect(() => loadEnv({ CORS_ORIGINS: '*' })).toThrow(/wildcard/);
    expect(() => loadEnv({ CORS_ORIGINS: 'localhost:3000' })).toThrow(/invalid origin/);
    expect(loadEnv({ CORS_ORIGINS: 'https://app.example.com, http://localhost:5173' }).CORS_ORIGINS).toHaveLength(2);
  });

  it('rejects invalid booleans, numbers and secrets without echoing secret values', () => {
    expect(() => loadEnv({ TRUST_PROXY: 'maybe' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ PORT: '70000' })).toThrow(EnvValidationError);
    try {
      loadEnv({ TAVILY_API_KEY: 'has space secretvalue' });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/TAVILY_API_KEY/);
      expect((e as Error).message).not.toMatch(/secretvalue/);
    }
  });

  it('configures Gemini with safe defaults and validates the model id', () => {
    const env = loadEnv({});
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.GEMINI_MODEL).toBe('gemini-3.6-flash');
    expect(env.GEMINI_MAX_OUTPUT_TOKENS).toBe(8192);
    expect(loadEnv({ GEMINI_MODEL: 'gemini-3.5-flash-lite' }).GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
    expect(() => loadEnv({ GEMINI_MODEL: '../../v1/files' })).toThrow(/GEMINI_MODEL/);
    expect(() => loadEnv({ GEMINI_API_KEY: 'has a space' })).toThrow(/GEMINI_API_KEY/);
  });

  it('validates PROVIDER_ROUTING syntax', () => {
    expect(loadEnv({ PROVIDER_ROUTING: 'web.search=exa|tavily' }).PROVIDER_ROUTING).toEqual(['web.search=exa|tavily']);
    expect(() => loadEnv({ PROVIDER_ROUTING: 'web.search:exa' })).toThrow(/PROVIDER_ROUTING/);
  });
});
