import type { CapabilityName } from './capabilities.js';

export type FetchFn = typeof fetch;

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  requests?: number;
}

export interface AdapterResult {
  output: unknown;
  usage?: ProviderUsage;
  /** Only set when the provider reports a cost or we can compute it from published per-token rates. */
  estimatedCostUsd?: number;
  /** The concrete model/variant that served the call, when relevant. */
  model?: string;
}

export interface InvokeContext {
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly CapabilityName[];
  /** Mock adapters must never be enabled in production and are labelled in every result. */
  readonly isMock: boolean;
  readonly docsUrl?: string;
  /** Name of the setting that enables this provider (e.g. "GEMINI_API_KEY"), for "why unavailable" messages. Never a value. */
  readonly requiredConfig?: string;
  /** True when the credentials/config needed to make real calls are present. */
  isConfigured(): boolean;
  /** Optional finer-grained readiness when some capabilities need extra config. */
  isCapabilityConfigured?(capability: CapabilityName): boolean;
  invoke(capability: CapabilityName, input: unknown, ctx: InvokeContext): Promise<AdapterResult>;
  /**
   * Optional active health probe. Only implemented when the provider offers a call that does not
   * consume paid quota (e.g. a metadata endpoint). Others report passive health from recent calls.
   */
  healthCheck?(ctx: InvokeContext): Promise<void>;
}
