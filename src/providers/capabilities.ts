import { z } from 'zod';

/**
 * Capability contracts. Each capability has one input and one output schema shared by every
 * adapter that implements it — that shared contract is what makes fallback between providers
 * of the same capability safe. `fallbackCompatible: false` marks capabilities where providers'
 * outputs are not interchangeable (e.g. embeddings live in different vector spaces).
 */

export const capabilityDefs = {
  'llm.generate': {
    description: 'Single-turn text generation from a prompt.',
    contentSource: 'model_generated',
    fallbackCompatible: false,
    input: z.object({
      prompt: z.string().min(1).max(200_000),
      system: z.string().max(50_000).optional(),
      maxTokens: z.number().int().min(1).max(128_000).optional(),
    }),
    output: z.object({
      text: z.string(),
      model: z.string(),
      stopReason: z.string().nullable(),
    }),
  },
  'text.embed': {
    description: 'Dense vector embeddings for a batch of texts.',
    contentSource: 'provider_data',
    fallbackCompatible: false,
    input: z.object({
      texts: z.array(z.string().min(1).max(32_000)).min(1).max(256),
      task: z.enum(['retrieval.query', 'retrieval.passage', 'text-matching', 'classification']).optional(),
      dimensions: z.number().int().min(32).max(4096).optional(),
    }),
    output: z.object({
      model: z.string(),
      dimensions: z.number().int(),
      embeddings: z.array(z.array(z.number())),
    }),
  },
  'text.rerank': {
    description: 'Re-order documents by relevance to a query.',
    contentSource: 'provider_data',
    fallbackCompatible: true,
    input: z.object({
      query: z.string().min(1).max(8_000),
      documents: z.array(z.string().min(1).max(32_000)).min(1).max(1_000),
      topN: z.number().int().min(1).max(1_000).optional(),
    }),
    output: z.object({
      model: z.string(),
      results: z.array(z.object({ index: z.number().int(), score: z.number(), document: z.string() })),
    }),
  },
  'web.search': {
    description: 'Web search returning titles, URLs and snippets.',
    contentSource: 'provider_data',
    fallbackCompatible: true,
    input: z.object({
      query: z.string().min(1).max(400),
      count: z.number().int().min(1).max(20).optional(),
    }),
    output: z.object({
      results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })),
    }),
  },
  'web.extract': {
    description: 'Fetch a public web page and return clean text/markdown.',
    contentSource: 'provider_data',
    fallbackCompatible: true,
    input: z.object({ url: z.string().min(1).max(2048) }),
    output: z.object({ url: z.string(), title: z.string(), content: z.string() }),
  },
  'github.repo': {
    description: 'Read-only public metadata for a GitHub repository.',
    contentSource: 'provider_data',
    fallbackCompatible: false,
    input: z.object({
      owner: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'invalid GitHub owner'),
      repo: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, 'invalid GitHub repo name'),
    }),
    output: z.object({
      fullName: z.string(),
      description: z.string().nullable(),
      htmlUrl: z.string(),
      defaultBranch: z.string(),
      stars: z.number().int(),
      forks: z.number().int(),
      openIssues: z.number().int(),
      language: z.string().nullable(),
      archived: z.boolean(),
      pushedAt: z.string().nullable(),
      license: z.string().nullable(),
    }),
  },
} as const;

export type CapabilityName = keyof typeof capabilityDefs;
export type CapabilityInput<C extends CapabilityName> = z.infer<(typeof capabilityDefs)[C]['input']>;
export type CapabilityOutput<C extends CapabilityName> = z.infer<(typeof capabilityDefs)[C]['output']>;
export type ContentSource = 'model_generated' | 'provider_data';

export const capabilityNames = Object.keys(capabilityDefs) as CapabilityName[];

export function isCapability(name: string): name is CapabilityName {
  return Object.prototype.hasOwnProperty.call(capabilityDefs, name);
}
