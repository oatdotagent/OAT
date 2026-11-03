import { describe, expect, it } from 'vitest';
import type { CapabilityName } from '../../src/providers/capabilities.js';
import { ProviderError, type ProviderErrorCode } from '../../src/providers/errors.js';
import { ProviderManager, type ProviderCallRecord, type ProviderManagerOptions } from '../../src/providers/manager.js';
import type { AdapterResult, ProviderAdapter } from '../../src/providers/types.js';

type Behaviour = Array<ProviderErrorCode | AdapterResult | 'bad-output'>;

class ScriptedAdapter implements ProviderAdapter {
  readonly displayName: string;
  readonly isMock = false;
  calls = 0;
  constructor(
    readonly id: string,
    readonly capabilities: readonly CapabilityName[],
    private readonly script: Behaviour,
    private readonly configured = true,
  ) {
    this.displayName = id;
  }
  isConfigured() {
    return this.configured;
  }
  async invoke(): Promise<AdapterResult> {
    const step = this.script[Math.min(this.calls++, this.script.length - 1)]!;
    if (step === 'bad-output') return { output: { wrong: true } };
    if (typeof step === 'string') throw new ProviderError(step, this.id, `${this.id} failed: ${step}`, step === 'rate_limited' ? { retryAfterMs: 1500 } : {});
    return step;
  }
}

const searchOk = (url = 'https://a.com'): AdapterResult => ({ output: { results: [{ title: 't', url, snippet: 's' }] } });

function manager(adapters: ProviderAdapter[], opts: Partial<ProviderManagerOptions> = {}) {
  const sleeps: number[] = [];
  const records: ProviderCallRecord[] = [];
  const m = new ProviderManager({
    timeoutMs: 1000,
    maxRetries: 2,
    fallbackEnabled: true,
    ssrf: { allowedHosts: [], blockedHosts: [], lookup: async () => [{ address: '93.184.215.14', family: 4 }] },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    onCall: (r) => records.push(r),
    ...opts,
  });
  adapters.forEach((a) => m.register(a));
  return { m, sleeps, records };
}

describe('ProviderManager', () => {
  it('gives AI text generation its own timeout, and a step timeout still wins', async () => {
    const seen: number[] = [];
    const capture = (id: string, capability: CapabilityName, output: unknown): ProviderAdapter => ({
      id,
      displayName: id,
      isMock: false,
      capabilities: [capability],
      isConfigured: () => true,
      invoke: async (_c, _i, ctx) => {
        seen.push(ctx.timeoutMs);
        return { output };
      },
    });
    const { m } = manager(
      [capture('llm', 'llm.generate', { text: 'ok', model: 'm', stopReason: null }), capture('web', 'web.search', { results: [] })],
      { llmTimeoutMs: 5000 },
    );
    await m.invoke('llm.generate', { prompt: 'hi' });
    await m.invoke('web.search', { query: 'q' });
    await m.invoke('llm.generate', { prompt: 'hi' }, { timeoutMs: 9000 });
    expect(seen).toEqual([5000, 1000, 9000]);
  });

  it('reports each retried attempt, and a failing listener cannot break the call', async () => {
    const retries: unknown[] = [];
    const a = new ScriptedAdapter('a', ['web.search'], ['timeout', 'upstream_error', searchOk()]);
    const { m } = manager([a], {
      onRetry: (r) => {
        retries.push(r);
        throw new Error('listener failed');
      },
    });
    await expect(m.invoke('web.search', { query: 'q' })).resolves.toMatchObject({ attempts: 3 });
    expect(retries).toEqual([
      expect.objectContaining({ provider: 'a', capability: 'web.search', errorCode: 'timeout', attempt: 1 }),
      expect.objectContaining({ provider: 'a', capability: 'web.search', errorCode: 'upstream_error', attempt: 2 }),
    ]);
  });

  it('does not retry a used-up quota and reports no retry for it', async () => {
    const retries: unknown[] = [];
    const a = new ScriptedAdapter('a', ['web.search'], ['quota_exceeded']);
    const { m } = manager([a], { onRetry: (r) => retries.push(r) });
    await expect(m.invoke('web.search', { query: 'q' })).rejects.toMatchObject({ code: 'quota_exceeded' });
    expect(a.calls).toBe(1);
    expect(retries).toEqual([]);
  });

  it('retries retryable errors with exponential backoff, then succeeds', async () => {
    const a = new ScriptedAdapter('a', ['web.search'], ['timeout', 'upstream_error', searchOk()]);
    const { m, sleeps, records } = manager([a]);
    const res = await m.invoke('web.search', { query: 'q' });
    expect(res).toMatchObject({ provider: 'a', attempts: 3, fallbackFrom: [] });
    expect(sleeps).toEqual([188, 375]); // base 250 * 2^(n-1), jitter fixed at 0.5 → 75%
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 'success', attempts: 3, provider: 'a' });
  });

  it('honours Retry-After when larger than the computed backoff', async () => {
    const a = new ScriptedAdapter('a', ['web.search'], ['rate_limited', searchOk()]);
    const { m, sleeps } = manager([a]);
    await m.invoke('web.search', { query: 'q' });
    expect(sleeps).toEqual([1500]);
  });

  it('does not retry non-retryable errors', async () => {
    const a = new ScriptedAdapter('a', ['web.search'], ['bad_request', searchOk()]);
    const { m } = manager([a]);
    await expect(m.invoke('web.search', { query: 'q' })).rejects.toMatchObject({ code: 'bad_request' });
    expect(a.calls).toBe(1);
  });

  it('falls back to the next compatible provider after retries are exhausted', async () => {
    const a = new ScriptedAdapter('a', ['web.search'], ['upstream_error']);
    const b = new ScriptedAdapter('b', ['web.search'], [searchOk('https://b.com')]);
    const { m, records } = manager([a, b]);
    const res = await m.invoke('web.search', { query: 'q' });
    expect(res).toMatchObject({ provider: 'b', fallbackFrom: ['a'] });
    expect(a.calls).toBe(3);
    expect(records.map((r) => [r.provider, r.status, r.errorCode])).toEqual([
      ['a', 'error', 'upstream_error'],
      ['b', 'success', undefined],
    ]);
  });

  it('does not retry quota_exceeded but still falls back to the next compatible provider', async () => {
    const a = new ScriptedAdapter('a', ['web.search'], ['quota_exceeded', searchOk()]);
    const b = new ScriptedAdapter('b', ['web.search'], [searchOk('https://b.com')]);
    const { m, sleeps } = manager([a, b]);
    const res = await m.invoke('web.search', { query: 'q' });
    expect(res).toMatchObject({ provider: 'b', fallbackFrom: ['a'] });
    expect(a.calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('never falls back for capabilities whose providers are not interchangeable', async () => {
    const embedOk = { output: { model: 'm', dimensions: 1, embeddings: [[1]] } };
    const a = new ScriptedAdapter('a', ['text.embed'], ['upstream_error']);
    const b = new ScriptedAdapter('b', ['text.embed'], [embedOk]);
    const { m } = manager([a, b]);
    await expect(m.invoke('text.embed', { texts: ['x'] })).rejects.toMatchObject({ code: 'upstream_error', provider: 'a' });
    expect(b.calls).toBe(0);
  });

  it('never falls back for pinned providers, or when fallback is disabled', async () => {
    const a = new ScriptedAdapter('a', ['web.search'], ['upstream_error']);
    const b = new ScriptedAdapter('b', ['web.search'], [searchOk()]);
    await expect(manager([a, b]).m.invoke('web.search', { query: 'q' }, { provider: 'a' })).rejects.toMatchObject({ provider: 'a' });
    const a2 = new ScriptedAdapter('a', ['web.search'], ['upstream_error']);
    const b2 = new ScriptedAdapter('b', ['web.search'], [searchOk()]);
    await expect(manager([a2, b2], { fallbackEnabled: false }).m.invoke('web.search', { query: 'q' })).rejects.toMatchObject({ provider: 'a' });
    expect(b.calls + b2.calls).toBe(0);
  });

  it('does not fall back on caller errors such as invalid input or refusals', async () => {
    const a = new ScriptedAdapter('a', ['web.search'], ['refused']);
    const b = new ScriptedAdapter('b', ['web.search'], [searchOk()]);
    await expect(manager([a, b]).m.invoke('web.search', { query: 'q' })).rejects.toMatchObject({ code: 'refused' });
    expect(b.calls).toBe(0);
  });

  it('validates input against the capability contract before calling providers', async () => {
    const a = new ScriptedAdapter('a', ['web.search'], [searchOk()]);
    const { m } = manager([a]);
    await expect(m.invoke('web.search', { query: '' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(m.invoke('nope.cap', {})).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(a.calls).toBe(0);
  });

  it('treats adapter output that violates the contract as malformed (and falls back)', async () => {
    const a = new ScriptedAdapter('a', ['web.search'], ['bad-output']);
    const b = new ScriptedAdapter('b', ['web.search'], [searchOk()]);
    const res = await manager([a, b]).m.invoke('web.search', { query: 'q' });
    expect(res).toMatchObject({ provider: 'b', fallbackFrom: ['a'] });
  });

  it('blocks SSRF targets before any provider is called', async () => {
    const a = new ScriptedAdapter('a', ['web.extract'], [{ output: { url: 'x', title: '', content: '' } }]);
    const { m } = manager([a]);
    await expect(m.invoke('web.extract', { url: 'http://169.254.169.254/latest' })).rejects.toMatchObject({ code: 'blocked_url' });
    expect(a.calls).toBe(0);
  });

  it('reports not_configured when no provider is ready, and skips unconfigured ones', async () => {
    const off = new ScriptedAdapter('off', ['web.search'], [searchOk()], false);
    const { m } = manager([off]);
    expect(m.canServe('web.search')).toBe(false);
    await expect(m.invoke('web.search', { query: 'q' })).rejects.toMatchObject({ code: 'not_configured' });
    await expect(m.invoke('web.search', { query: 'q' }, { provider: 'off' })).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('tracks health and deprioritizes unhealthy providers', async () => {
    const a = new ScriptedAdapter('a', ['web.search'], ['network_error']);
    const b = new ScriptedAdapter('b', ['web.search'], [searchOk()]);
    const { m } = manager([a, b], { maxRetries: 0 });
    expect(m.healthStatus('a')).toBe('unknown');
    await m.invoke('web.search', { query: 'q' });
    expect(m.healthStatus('a')).toBe('degraded');
    expect(m.healthStatus('b')).toBe('healthy');
    await m.invoke('web.search', { query: 'q' });
    await m.invoke('web.search', { query: 'q' });
    expect(m.healthStatus('a')).toBe('unhealthy');
    expect(m.candidates('web.search').map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('respects configured routing order', () => {
    const a = new ScriptedAdapter('a', ['web.search'], [searchOk()]);
    const b = new ScriptedAdapter('b', ['web.search'], [searchOk()]);
    const { m } = manager([a, b], { routing: { 'web.search': ['b', 'a'] } });
    expect(m.candidates('web.search').map((x) => x.id)).toEqual(['b', 'a']);
  });

  it('treats PROVIDER_ROUTING as strict: an unconfigured routed provider is never silently replaced', async () => {
    const other = new ScriptedAdapter('other', ['web.search'], [searchOk()]);
    const routed = Object.assign(new ScriptedAdapter('routed', ['web.search'], [searchOk()], false), { requiredConfig: 'ROUTED_API_KEY', displayName: 'Routed' });
    const { m } = manager([other, routed], { routing: { 'web.search': ['routed'] } });
    expect(m.candidates('web.search')).toEqual([]);
    expect(m.canServe('web.search')).toBe(false);
    const reason = m.unavailableReason('web.search')!;
    expect(reason).toContain('routed to routed (PROVIDER_ROUTING)');
    expect(reason).toContain('ROUTED_API_KEY is not set');
    await expect(m.invoke('web.search', { query: 'q' })).rejects.toMatchObject({ code: 'not_configured', message: reason });
    expect(other.calls).toBe(0);
    // An explicit per-step provider pin is intentional, not a silent substitution.
    await expect(m.invoke('web.search', { query: 'q' }, { provider: 'other' })).resolves.toMatchObject({ provider: 'other' });
  });

  it('explains unavailability by naming the missing setting, never a value', () => {
    const off = Object.assign(new ScriptedAdapter('g', ['llm.generate'], [], false), { requiredConfig: 'GEMINI_API_KEY', displayName: 'Google Gemini' });
    const { m } = manager([off]);
    expect(m.providerUnavailableReason('g')).toBe('Google Gemini is disabled: GEMINI_API_KEY is not set');
    expect(m.unavailableReason('llm.generate')).toBe('No configured provider offers llm.generate. Set one of: GEMINI_API_KEY');
    expect(m.describe()[0]).toMatchObject({ configured: false, unavailableReason: 'Google Gemini is disabled: GEMINI_API_KEY is not set' });
  });

  it('rejects routing to unknown providers or providers without the capability', () => {
    const a = new ScriptedAdapter('a', ['web.search'], [searchOk()]);
    expect(() => manager([a], { routing: { 'web.search': ['gemnii'] } }).m.validateRouting()).toThrow(/unknown provider "gemnii"/);
    expect(() => manager([a], { routing: { 'llm.generate': ['a'] } }).m.validateRouting()).toThrow(/does not offer llm.generate/);
    expect(() => manager([a], { routing: { 'web.search': ['a'] } }).m.validateRouting()).not.toThrow();
  });

  it('stops retrying when cancelled', async () => {
    const a = new ScriptedAdapter('a', ['web.search'], ['timeout']);
    const ac = new AbortController();
    const { m } = manager([a], {
      sleep: async () => {
        ac.abort();
        throw new Error('aborted');
      },
    });
    await expect(m.invoke('web.search', { query: 'q' }, { signal: ac.signal })).rejects.toMatchObject({ code: 'cancelled' });
    expect(a.calls).toBe(1);
  });

  it('describe() never exposes configuration values', () => {
    const { m } = manager([new ScriptedAdapter('a', ['web.search'], [searchOk()])]);
    const text = JSON.stringify(m.describe());
    expect(text).not.toMatch(/key|token|secret/i);
  });
});
