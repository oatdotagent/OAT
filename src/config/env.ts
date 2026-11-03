import { z } from 'zod';

/**
 * Strict environment validation. Every variable the backend reads is declared
 * here; the process refuses to start on invalid configuration rather than
 * failing later at request time.
 */

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const optionalSecret = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .min(8, 'looks too short to be a real credential')
    .max(512)
    .regex(/^\S+$/, 'must not contain whitespace')
    .optional(),
);

const bool = (def: boolean) =>
  z.preprocess((v) => {
    const s = emptyToUndefined(v);
    if (s === undefined) return def;
    if (typeof s === 'boolean') return s;
    const lowered = String(s).toLowerCase();
    if (['true', '1', 'yes'].includes(lowered)) return true;
    if (['false', '0', 'no'].includes(lowered)) return false;
    return s; // let z.boolean() reject it
  }, z.boolean());

const int = (def: number, min: number, max: number) =>
  z.preprocess((v) => emptyToUndefined(v) ?? def, z.coerce.number().int().min(min).max(max));

const csv = z.preprocess(
  (v) =>
    typeof v === 'string'
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : (v ?? []),
  z.array(z.string()),
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.preprocess(emptyToUndefined, z.string().default('127.0.0.1')),
    PORT: int(3000, 1, 65535),
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    ),
    TRUST_PROXY: bool(false),

    // Gateway
    CORS_ORIGINS: csv,
    BODY_LIMIT_BYTES: int(1_048_576, 1024, 10 * 1_048_576),
    RATE_LIMIT_MAX: int(120, 1, 100_000),
    RATE_LIMIT_WINDOW_MS: int(60_000, 1000, 3_600_000),
    EXECUTION_RATE_LIMIT_MAX: int(20, 1, 10_000),

    // Frontend (built by `npm run build:web`; served same-origin when the directory exists)
    SERVE_WEB: bool(true),
    WEB_DIST_DIR: z.preprocess(emptyToUndefined, z.string().default('./web/dist')),

    // Storage
    DATABASE_PATH: z.preprocess(emptyToUndefined, z.string().default('./data/oat.db')),

    // Auth: comma-separated "userId:role:sha256hex" entries. Generate with `npm run token:create`.
    AUTH_TOKENS: csv,
    AUTH_DEV_BYPASS: bool(false),
    USER_ALLOWED_CAPABILITIES: z.preprocess(
      (v) => emptyToUndefined(v) ?? 'llm.generate,text.embed,text.rerank,web.search,web.extract,github.repo',
      csv,
    ),

    // Provider manager
    PROVIDER_TIMEOUT_MS: int(30_000, 1000, 600_000),
    LLM_TIMEOUT_MS: int(120_000, 1000, 600_000),
    PROVIDER_MAX_RETRIES: int(2, 0, 5),
    PROVIDER_FALLBACK_ENABLED: bool(true),
    PROVIDER_ROUTING: csv, // e.g. "web.search=tavily|exa,text.rerank=jina"
    ENABLE_MOCK_PROVIDERS: bool(false),

    // Orchestration
    MAX_CONCURRENT_EXECUTIONS: int(4, 1, 64),
    EXECUTION_TIMEOUT_MS: int(300_000, 5000, 3_600_000),
    MAX_STORED_OUTPUT_BYTES: int(262_144, 1024, 16 * 1_048_576),

    // SSRF policy for URL-taking capabilities
    SSRF_BLOCKED_HOSTS: csv,
    SSRF_ALLOWED_HOSTS: csv, // if non-empty, only these hosts (and their subdomains) are allowed

    // Providers (all optional; a provider is disabled until its key is set)
    ANTHROPIC_API_KEY: optionalSecret,
    ANTHROPIC_MODEL: z.preprocess(emptyToUndefined, z.string().default('claude-opus-5-5')),
    ANTHROPIC_EFFORT: z.preprocess(
      emptyToUndefined,
      z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
    ),
    ANTHROPIC_MAX_TOKENS: int(16_000, 1, 128_000),

    // Google Gemini API key from https://aistudio.google.com/apikey (free tier available)
    GEMINI_API_KEY: optionalSecret,
    GEMINI_MODEL: z.preprocess(
      emptyToUndefined,
      z.string().regex(/^[a-z0-9][a-z0-9.-]{1,63}$/, 'must be a Gemini model id such as gemini-3.6-flash').default('gemini-3.6-flash'),
    ),
    GEMINI_MAX_OUTPUT_TOKENS: int(8192, 1, 65_536),

    JINA_API_KEY: optionalSecret,
    JINA_READER_KEYLESS: bool(false),
    JINA_EMBEDDING_MODEL: z.preprocess(emptyToUndefined, z.string().default('jina-embeddings-v5-text-small')),
    JINA_RERANK_MODEL: z.preprocess(emptyToUndefined, z.string().default('jina-reranker-v3')),

    // Tavily web search key from https://app.tavily.com (primary web.search provider)
    TAVILY_API_KEY: optionalSecret,
    EXA_API_KEY: optionalSecret,
    GITHUB_TOKEN: optionalSecret,
  })
  .superRefine((env, ctx) => {
    for (const entry of env.AUTH_TOKENS) {
      if (!/^[A-Za-z0-9_.-]{1,64}:(admin|user):[a-f0-9]{64}$/.test(entry)) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_TOKENS'],
          message: 'each entry must be "userId:admin|user:<sha256 hex>" (raw tokens are not accepted)',
        });
        break;
      }
    }
    for (const rule of env.PROVIDER_ROUTING) {
      if (!/^[a-z.]+=[a-z0-9-]+(\|[a-z0-9-]+)*$/.test(rule)) {
        ctx.addIssue({ code: 'custom', path: ['PROVIDER_ROUTING'], message: `invalid rule "${rule}"` });
      }
    }
    if (env.CORS_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'wildcard origin is not allowed; list explicit origins',
      });
    }
    for (const origin of env.CORS_ORIGINS) {
      if (!/^https?:\/\/[^/\s]+$/.test(origin)) {
        ctx.addIssue({ code: 'custom', path: ['CORS_ORIGINS'], message: `invalid origin "${origin}"` });
      }
    }
    if (env.NODE_ENV === 'production') {
      if (env.AUTH_TOKENS.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['AUTH_TOKENS'], message: 'required in production' });
      }
      if (env.AUTH_DEV_BYPASS) {
        ctx.addIssue({ code: 'custom', path: ['AUTH_DEV_BYPASS'], message: 'must be false in production' });
      }
      if (env.ENABLE_MOCK_PROVIDERS) {
        ctx.addIssue({
          code: 'custom',
          path: ['ENABLE_MOCK_PROVIDERS'],
          message: 'mock providers must not be enabled in production',
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Parses and validates env vars. Error messages name variables but never echo their values. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return result.data;
}
