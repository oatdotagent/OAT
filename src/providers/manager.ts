import { assertPublicUrl, BlockedUrlError, type SsrfPolicy } from '../lib/ssrf.js';
import { capabilityDefs, isCapability, type CapabilityName } from './capabilities.js';
import { ProviderError, type ProviderErrorCode } from './errors.js';
import type { ProviderAdapter, ProviderUsage } from './types.js';

export type HealthStatus = 'disabled' | 'unknown' | 'healthy' | 'degraded' | 'unhealthy';

export interface ProviderCallRecord {
  ts: string;
  provider: string;
  capability: CapabilityName;
  status: 'success' | 'error';
  errorCode?: ProviderErrorCode;
  latencyMs: number;
  attempts: number;
  usage?: ProviderUsage;
  estimatedCostUsd?: number;
  isMock: boolean;
  executionId?: string;
  requestId?: string;
}

export interface InvokeOptions {
  /** Pin a provider. Pinned calls never fall back. */
  provider?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  executionId?: string;
  requestId?: string;
}

export interface InvokeResult {
  output: unknown;
  provider: string;
  isMock: boolean;
  attempts: number;
  latencyMs: number;
  usage?: ProviderUsage;
  estimatedCostUsd?: number;
  /** Providers that were tried and failed before `provider` succeeded. */
  fallbackFrom: string[];
}

export interface ProviderManagerOptions {
  timeoutMs: number;
  maxRetries: number;
  fallbackEnabled: boolean;
  /** capability → ordered provider ids, e.g. { 'web.search': ['tavily', 'exa'] } */
  routing?: Partial<Record<CapabilityName, string[]>>;
  ssrf: SsrfPolicy;
  onCall?: (record: ProviderCallRecord) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

interface HealthState {
  consecutiveFailures: number;
  totalCalls: number;
  totalErrors: number;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: { code: ProviderErrorCode; message: string };
  lastCheck?: { at: string; ok: boolean; mode: 'active' };
}

// Failures that say something about the provider (so another provider may do better).
const FALLBACK_ELIGIBLE: ReadonlySet<ProviderErrorCode> = new Set([
  'timeout',
  'rate_limited',
  'upstream_error',
  'network_error',
  'auth_failed',
  'malformed_response',
  'not_configured',
  'quota_exceeded',
]);

const UNHEALTHY_AFTER = 3;

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Central registry and dispatcher for external providers. Responsibilities:
 * input/output contract validation, SSRF preflight, routing, per-attempt timeouts,
 * retry with exponential backoff + jitter (honouring Retry-After), fallback between
 * compatible providers, passive/active health tracking and usage/cost recording.
 */
export class ProviderManager {
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly health = new Map<string, HealthState>();

  constructor(private readonly opts: ProviderManagerOptions) {}

  register(adapter: ProviderAdapter): this {
    if (this.adapters.has(adapter.id)) throw new Error(`Provider ${adapter.id} already registered`);
    this.adapters.set(adapter.id, adapter);
    this.health.set(adapter.id, { consecutiveFailures: 0, totalCalls: 0, totalErrors: 0 });
    return this;
  }

  get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  isReady(adapter: ProviderAdapter, capability: CapabilityName): boolean {
    if (!adapter.capabilities.includes(capability)) return false;
    return adapter.isCapabilityConfigured ? adapter.isCapabilityConfigured(capability) : adapter.isConfigured();
  }

  /**
   * Ordered list of ready providers for a capability (unhealthy last; mocks last).
   * When PROVIDER_ROUTING names providers for the capability, ONLY those may serve it, in that
   * order — a routed provider that isn't configured makes the capability unavailable instead of
   * silently handing the work to some other provider or the mock.
   */
  candidates(capability: CapabilityName): ProviderAdapter[] {
    const routed = this.opts.routing?.[capability] ?? [];
    const all = [...this.adapters.values()].filter((a) => this.isReady(a, capability) && (routed.length === 0 || routed.includes(a.id)));
    const rank = (a: ProviderAdapter) => {
      const r = routed.indexOf(a.id);
      const routeRank = r === -1 ? routed.length : r;
      const unhealthy = this.healthStatus(a.id) === 'unhealthy' ? 1 : 0;
      return (a.isMock ? 1_000_000 : 0) + unhealthy * 1000 + routeRank;
    };
    return all.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((x) => x.a);
  }

  /** Providers PROVIDER_ROUTING restricts this capability to, or null when unrestricted. */
  routedTo(capability: CapabilityName): string[] | null {
    const routed = this.opts.routing?.[capability];
    return routed && routed.length > 0 ? [...routed] : null;
  }

  /** Why a provider can't be used — names the missing setting, never a value. Null when ready. */
  providerUnavailableReason(id: string, capability?: CapabilityName): string | null {
    const a = this.adapters.get(id);
    if (!a) return `Unknown provider "${id}"`;
    if (capability && !a.capabilities.includes(capability)) return `${a.displayName} does not offer ${capability}`;
    const ready = capability ? this.isReady(a, capability) : a.isConfigured();
    if (ready) return null;
    return `${a.displayName} is disabled: ${a.requiredConfig ? `${a.requiredConfig} is not set` : 'not configured'}`;
  }

  /** Why a capability can't be served right now, or null when it can. */
  unavailableReason(capability: CapabilityName, provider?: string): string | null {
    if (provider) return this.providerUnavailableReason(provider, capability);
    if (this.candidates(capability).length > 0) return null;
    const routed = this.routedTo(capability);
    if (routed) {
      const why = routed.map((id) => this.providerUnavailableReason(id, capability)).filter(Boolean).join('; ');
      return `${capability} is routed to ${routed.join(', ')} (PROVIDER_ROUTING) and no routed provider is ready. ${why}`;
    }
    const options = [...this.adapters.values()].filter((a) => a.capabilities.includes(capability) && !a.isMock).map((a) => a.requiredConfig ?? a.id);
    return `No configured provider offers ${capability}. Set one of: ${options.join(', ')}`;
  }

  /** Fail fast on PROVIDER_ROUTING that names unknown providers or ones that don't offer the capability. */
  validateRouting(): void {
    for (const [capability, ids] of Object.entries(this.opts.routing ?? {}) as Array<[CapabilityName, string[]]>) {
      for (const id of ids) {
        const a = this.adapters.get(id);
        if (!a) throw new Error(`PROVIDER_ROUTING: unknown provider "${id}" for ${capability} (known: ${[...this.adapters.keys()].join(', ')})`);
        if (!a.capabilities.includes(capability)) throw new Error(`PROVIDER_ROUTING: provider "${id}" does not offer ${capability}`);
      }
    }
  }

  /** Is this capability servable (optionally by a specific provider)? Used by workflow validation. */
  canServe(capability: CapabilityName, provider?: string): boolean {
    if (provider) {
      const a = this.adapters.get(provider);
      return a !== undefined && this.isReady(a, capability);
    }
    return this.candidates(capability).length > 0;
  }

  async invoke(capability: string, rawInput: unknown, options: InvokeOptions = {}): Promise<InvokeResult> {
    if (!isCapability(capability)) {
      throw new ProviderError('unsupported_capability', 'manager', `Unknown capability "${capability}"`);
    }
    const def = capabilityDefs[capability];
    const parsedInput = def.input.safeParse(rawInput);
    if (!parsedInput.success) {
      const issue = parsedInput.error.issues[0];
      throw new ProviderError(
        'invalid_input',
        'manager',
        `Invalid input for ${capability}${issue ? ` at ${issue.path.join('.') || '(root)'}: ${issue.message}` : ''}`,
      );
    }
    const input = parsedInput.data;
    await this.preflight(capability, input);

    let chain: ProviderAdapter[];
    if (options.provider) {
      const pinned = this.adapters.get(options.provider);
      if (!pinned || !pinned.capabilities.includes(capability)) {
        throw new ProviderError('unsupported_capability', options.provider, `Provider "${options.provider}" does not offer ${capability}`);
      }
      if (!this.isReady(pinned, capability)) {
        throw new ProviderError('not_configured', pinned.id, `Provider "${pinned.id}" is not configured for ${capability}`);
      }
      chain = [pinned];
    } else {
      chain = this.candidates(capability);
      if (chain.length === 0) {
        throw new ProviderError('not_configured', 'manager', this.unavailableReason(capability) ?? `No configured provider offers ${capability}`);
      }
      if (!this.opts.fallbackEnabled || !def.fallbackCompatible) chain = chain.slice(0, 1);
    }

    const signal = options.signal ?? new AbortController().signal;
    const failed: string[] = [];
    let lastError: ProviderError | undefined;
    for (const adapter of chain) {
      try {
        const result = await this.invokeWithRetry(adapter, capability, input, signal, options);
        return { ...result, fallbackFrom: failed };
      } catch (err) {
        const pe = err instanceof ProviderError ? err : new ProviderError('upstream_error', adapter.id, String(err));
        lastError = pe;
        failed.push(adapter.id);
        if (!FALLBACK_ELIGIBLE.has(pe.code)) throw pe;
      }
    }
    throw lastError ?? new ProviderError('upstream_error', 'manager', 'All providers failed');
  }

  private async preflight(capability: CapabilityName, input: unknown): Promise<void> {
    if (capability === 'web.extract') {
      const { url } = input as { url: string };
      try {
        await assertPublicUrl(url, this.opts.ssrf);
      } catch (err) {
        if (err instanceof BlockedUrlError) throw new ProviderError('blocked_url', 'manager', err.message);
        throw err;
      }
    }
  }

  private async invokeWithRetry(
    adapter: ProviderAdapter,
    capability: CapabilityName,
    input: unknown,
    signal: AbortSignal,
    options: InvokeOptions,
  ): Promise<Omit<InvokeResult, 'fallbackFrom'>> {
    const maxRetries = options.maxRetries ?? this.opts.maxRetries;
    const timeoutMs = options.timeoutMs ?? this.opts.timeoutMs;
    const sleep = this.opts.sleep ?? defaultSleep;
    const started = performance.now();
    let attempts = 0;

    for (;;) {
      attempts++;
      if (signal.aborted) throw new ProviderError('cancelled', adapter.id, 'Request cancelled');
      try {
        const res = await adapter.invoke(capability, input, { signal, timeoutMs });
        const parsed = capabilityDefs[capability].output.safeParse(res.output);
        if (!parsed.success) {
          throw new ProviderError('malformed_response', adapter.id, `Adapter output violates the ${capability} contract`);
        }
        const latencyMs = Math.round(performance.now() - started);
        this.markSuccess(adapter.id);
        this.record({
          provider: adapter.id,
          capability,
          status: 'success',
          latencyMs,
          attempts,
          usage: res.usage,
          estimatedCostUsd: res.estimatedCostUsd,
          isMock: adapter.isMock,
          executionId: options.executionId,
          requestId: options.requestId,
        });
        return {
          output: parsed.data,
          provider: adapter.id,
          isMock: adapter.isMock,
          attempts,
          latencyMs,
          usage: res.usage,
          estimatedCostUsd: res.estimatedCostUsd,
        };
      } catch (err) {
        const pe =
          err instanceof ProviderError
            ? err
            : new ProviderError('upstream_error', adapter.id, `Unexpected adapter error: ${(err as Error)?.message}`);
        const canRetry = pe.retryable && attempts <= maxRetries && !signal.aborted;
        if (!canRetry) {
          if (pe.code !== 'cancelled') this.markFailure(adapter.id, pe);
          this.record({
            provider: adapter.id,
            capability,
            status: 'error',
            errorCode: pe.code,
            latencyMs: Math.round(performance.now() - started),
            attempts,
            isMock: adapter.isMock,
            executionId: options.executionId,
            requestId: options.requestId,
          });
          throw pe;
        }
        try {
          await sleep(this.backoffMs(attempts, pe.options.retryAfterMs), signal);
        } catch {
          throw new ProviderError('cancelled', adapter.id, 'Request cancelled during backoff');
        }
      }
    }
  }

  backoffMs(attempt: number, retryAfterMs?: number): number {
    const base = this.opts.baseDelayMs ?? 250;
    const max = this.opts.maxDelayMs ?? 10_000;
    const exp = Math.min(max, base * 2 ** (attempt - 1));
    const jittered = exp / 2 + (this.opts.random ?? Math.random)() * (exp / 2);
    return Math.max(Math.round(jittered), retryAfterMs ?? 0);
  }

  private record(r: Omit<ProviderCallRecord, 'ts'>): void {
    try {
      this.opts.onCall?.({ ts: new Date().toISOString(), ...r });
    } catch {
      // Observability must never break a provider call.
    }
  }

  private markSuccess(id: string): void {
    const h = this.health.get(id);
    if (!h) return;
    h.totalCalls++;
    h.consecutiveFailures = 0;
    h.lastSuccessAt = new Date().toISOString();
  }

  private markFailure(id: string, err: ProviderError): void {
    const h = this.health.get(id);
    if (!h) return;
    h.totalCalls++;
    h.totalErrors++;
    // Caller mistakes say nothing about provider health.
    if (['invalid_input', 'bad_request', 'not_found', 'refused', 'blocked_url'].includes(err.code)) return;
    h.consecutiveFailures++;
    h.lastErrorAt = new Date().toISOString();
    h.lastError = { code: err.code, message: err.message };
  }

  healthStatus(id: string): HealthStatus {
    const a = this.adapters.get(id);
    const h = this.health.get(id);
    if (!a || !h) return 'unknown';
    if (!a.isConfigured()) return 'disabled';
    if (h.consecutiveFailures >= UNHEALTHY_AFTER) return 'unhealthy';
    if (h.consecutiveFailures > 0) return 'degraded';
    if (!h.lastSuccessAt && !h.lastCheck) return 'unknown';
    return 'healthy';
  }

  /** Public description — never includes credentials or config values. */
  describe() {
    return [...this.adapters.values()].map((a) => {
      const h = this.health.get(a.id)!;
      return {
        id: a.id,
        displayName: a.displayName,
        isMock: a.isMock,
        configured: a.isConfigured(),
        unavailableReason: this.providerUnavailableReason(a.id),
        capabilities: a.capabilities.map((c) => ({ name: c, ready: this.isReady(a, c) })),
        docsUrl: a.docsUrl ?? null,
        health: {
          status: this.healthStatus(a.id),
          consecutiveFailures: h.consecutiveFailures,
          totalCalls: h.totalCalls,
          totalErrors: h.totalErrors,
          lastSuccessAt: h.lastSuccessAt ?? null,
          lastErrorAt: h.lastErrorAt ?? null,
          lastError: h.lastError ?? null,
          lastActiveCheck: h.lastCheck ?? null,
          probe: a.healthCheck ? 'active' : 'passive',
        },
      };
    });
  }

  /**
   * Run active probes where an adapter offers one (no paid quota consumed); others report
   * passive status derived from recent calls.
   */
  async checkHealth(signal?: AbortSignal) {
    const results = await Promise.all(
      [...this.adapters.values()].map(async (a) => {
        if (!a.isConfigured()) return { id: a.id, mode: 'skipped' as const, status: 'disabled' as HealthStatus };
        if (!a.healthCheck) return { id: a.id, mode: 'passive' as const, status: this.healthStatus(a.id) };
        const h = this.health.get(a.id)!;
        const started = performance.now();
        try {
          await a.healthCheck({ signal: signal ?? new AbortController().signal, timeoutMs: Math.min(this.opts.timeoutMs, 10_000) });
          h.lastCheck = { at: new Date().toISOString(), ok: true, mode: 'active' };
          h.consecutiveFailures = 0;
          return { id: a.id, mode: 'active' as const, status: this.healthStatus(a.id), latencyMs: Math.round(performance.now() - started) };
        } catch (err) {
          const pe = err instanceof ProviderError ? err : new ProviderError('upstream_error', a.id, String(err));
          h.lastCheck = { at: new Date().toISOString(), ok: false, mode: 'active' };
          h.consecutiveFailures++;
          h.lastErrorAt = h.lastCheck.at;
          h.lastError = { code: pe.code, message: pe.message };
          return { id: a.id, mode: 'active' as const, status: this.healthStatus(a.id), error: pe.toJSON() };
        }
      }),
    );
    return results;
  }
}

/** Parse PROVIDER_ROUTING entries like "web.search=tavily|exa". Unknown capabilities are rejected. */
export function parseRouting(entries: string[]): Partial<Record<CapabilityName, string[]>> {
  const out: Partial<Record<CapabilityName, string[]>> = {};
  for (const entry of entries) {
    const [cap, providers] = entry.split('=');
    if (!cap || !providers || !isCapability(cap)) throw new Error(`PROVIDER_ROUTING: unknown capability in "${entry}"`);
    out[cap] = providers.split('|');
  }
  return out;
}
