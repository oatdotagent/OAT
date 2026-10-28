import { createHash } from 'node:crypto';
import { capabilityNames, type CapabilityInput, type CapabilityName } from '../capabilities.js';
import type { AdapterResult, InvokeContext, ProviderAdapter } from '../types.js';

/**
 * MOCK PROVIDER — development and testing only.
 * Returns deterministic, obviously-fake data prefixed with "[MOCK]". It never contacts any
 * external service. Env validation forbids enabling it in production, and every execution
 * record and verification produced from it is labelled `mock`.
 */
export class MockAdapter implements ProviderAdapter {
  readonly id = 'mock';
  readonly displayName = 'Mock provider (development only)';
  readonly capabilities = capabilityNames;
  readonly isMock = true;
  readonly requiredConfig = 'ENABLE_MOCK_PROVIDERS=true (development only)';

  constructor(private readonly enabled: boolean) {}

  isConfigured(): boolean {
    return this.enabled;
  }

  async invoke(capability: CapabilityName, input: unknown, _ctx: InvokeContext): Promise<AdapterResult> {
    switch (capability) {
      case 'llm.generate': {
        const { prompt } = input as CapabilityInput<'llm.generate'>;
        return {
          output: { text: `[MOCK] Generated response for: ${prompt.slice(0, 200)}`, model: 'mock-llm', stopReason: 'end_turn' },
          model: 'mock-llm',
          usage: { inputTokens: prompt.length, outputTokens: 10 },
        };
      }
      case 'text.embed': {
        const { texts, dimensions } = input as CapabilityInput<'text.embed'>;
        const dims = dimensions ?? 8;
        return {
          output: { model: 'mock-embed', dimensions: dims, embeddings: texts.map((t) => pseudoVector(t, dims)) },
          model: 'mock-embed',
        };
      }
      case 'text.rerank': {
        const { query, documents, topN } = input as CapabilityInput<'text.rerank'>;
        const q = query.toLowerCase();
        const results = documents
          .map((document, index) => ({ index, document, score: document.toLowerCase().includes(q) ? 0.9 : 0.1 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, topN ?? documents.length);
        return { output: { model: 'mock-rerank', results } };
      }
      case 'web.search': {
        const { query, count } = input as CapabilityInput<'web.search'>;
        const n = count ?? 3;
        return {
          output: {
            results: Array.from({ length: n }, (_, i) => ({
              title: `[MOCK] Result ${i + 1} for "${query}"`,
              url: `https://example.com/mock/${i + 1}`,
              snippet: `[MOCK] Snippet ${i + 1}`,
            })),
          },
        };
      }
      case 'web.extract': {
        const { url } = input as CapabilityInput<'web.extract'>;
        return { output: { url, title: '[MOCK] Page title', content: `[MOCK] Extracted content of ${url}` } };
      }
      case 'github.repo': {
        const { owner, repo } = input as CapabilityInput<'github.repo'>;
        return {
          output: {
            fullName: `${owner}/${repo}`,
            description: '[MOCK] repository',
            htmlUrl: `https://github.com/${owner}/${repo}`,
            defaultBranch: 'main',
            stars: 0,
            forks: 0,
            openIssues: 0,
            language: null,
            archived: false,
            pushedAt: null,
            license: null,
          },
        };
      }
    }
  }
}

function pseudoVector(text: string, dims: number): number[] {
  const digest = createHash('sha256').update(text).digest();
  return Array.from({ length: dims }, (_, i) => ((digest[i % digest.length] ?? 0) / 255) * 2 - 1);
}
