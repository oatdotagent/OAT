import type { Env } from '../config/env.js';
import { AnthropicAdapter } from './adapters/anthropic.js';
import { ExaSearchAdapter } from './adapters/exa.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { GitHubAdapter } from './adapters/github.js';
import { JinaAdapter } from './adapters/jina.js';
import { MockAdapter } from './adapters/mock.js';
import { TavilySearchAdapter } from './adapters/tavily.js';
import { ProviderManager, parseRouting, type ProviderManagerOptions } from './manager.js';
import type { FetchFn } from './types.js';

/**
 * Builds the provider manager from validated env. Registration order is the default routing
 * order when PROVIDER_ROUTING does not specify one. Keys stay inside the adapters; nothing here
 * is ever serialized to clients.
 */
export function buildProviderManager(
  env: Env,
  extra: Pick<ProviderManagerOptions, 'onCall' | 'sleep'> & { fetchImpl?: FetchFn; lookup?: ProviderManagerOptions['ssrf']['lookup'] } = {},
): ProviderManager {
  const manager = new ProviderManager({
    timeoutMs: env.PROVIDER_TIMEOUT_MS,
    maxRetries: env.PROVIDER_MAX_RETRIES,
    fallbackEnabled: env.PROVIDER_FALLBACK_ENABLED,
    routing: parseRouting(env.PROVIDER_ROUTING),
    ssrf: { allowedHosts: env.SSRF_ALLOWED_HOSTS, blockedHosts: env.SSRF_BLOCKED_HOSTS, lookup: extra.lookup },
    onCall: extra.onCall,
    sleep: extra.sleep,
  });
  const fetchImpl = extra.fetchImpl;

  manager
    .register(
      new AnthropicAdapter({
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.ANTHROPIC_MODEL,
        effort: env.ANTHROPIC_EFFORT,
        maxTokens: env.ANTHROPIC_MAX_TOKENS,
      }),
    )
    .register(new GeminiAdapter({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, maxOutputTokens: env.GEMINI_MAX_OUTPUT_TOKENS, fetchImpl }))
    .register(
      new JinaAdapter({
        apiKey: env.JINA_API_KEY,
        readerKeyless: env.JINA_READER_KEYLESS,
        embeddingModel: env.JINA_EMBEDDING_MODEL,
        rerankModel: env.JINA_RERANK_MODEL,
        fetchImpl,
      }),
    )
    .register(new TavilySearchAdapter({ apiKey: env.TAVILY_API_KEY, fetchImpl }))
    .register(new ExaSearchAdapter({ apiKey: env.EXA_API_KEY, fetchImpl }))
    .register(new GitHubAdapter({ token: env.GITHUB_TOKEN, fetchImpl }))
    .register(new MockAdapter(env.ENABLE_MOCK_PROVIDERS && env.NODE_ENV !== 'production'));

  manager.validateRouting();
  return manager;
}
