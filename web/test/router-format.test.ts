import { describe, expect, it } from 'vitest';
import { navSection, parseRoute } from '../src/console/router';
import { formatCost, formatDuration, formatRelative, parseJsonInput, shortId, statusTone } from '../src/lib/format';
import { looksLikeToken } from '../src/lib/session';

const WF = `wf_${'a'.repeat(32)}`;
const EX = `ex_${'b'.repeat(32)}`;

describe('parseRoute', () => {
  it.each([
    ['', { name: 'overview' }],
    ['#/', { name: 'overview' }],
    ['#/overview', { name: 'overview' }],
    ['#/workflows', { name: 'workflows' }],
    ['#/workflows/new', { name: 'workflow-new' }],
    [`#/workflows/${WF}`, { name: 'workflow', id: WF }],
    ['#/executions?status=failed', { name: 'executions' }],
    [`#/executions/${EX}/`, { name: 'execution', id: EX }],
    ['#/metrics', { name: 'metrics' }],
  ])('%s', (hash, expected) => expect(parseRoute(hash)).toEqual(expected));

  it('rejects malformed ids and unknown paths', () => {
    expect(parseRoute('#/workflows/../../etc').name).toBe('not-found');
    expect(parseRoute(`#/workflows/${EX}`).name).toBe('not-found');
    expect(parseRoute('#/admin').name).toBe('not-found');
  });

  it('maps detail routes to their nav section', () => {
    expect(navSection({ name: 'execution', id: EX })).toBe('executions');
    expect(navSection({ name: 'workflow-new' })).toBe('workflows');
  });
});

describe('format helpers', () => {
  it('formats durations and relative times', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(420)).toBe('420 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(125_000)).toBe('2 m 5 s');
    const now = Date.parse('2026-01-01T00:10:00Z');
    expect(formatRelative('2026-01-01T00:09:30Z', now)).toBe('30s ago');
    expect(formatRelative('2026-01-01T00:00:00Z', now)).toBe('10m ago');
  });

  it('never renders an unreported cost as zero', () => {
    expect(formatCost(null)).toBe('Not reported');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.0042)).toBe('$0.0042');
    expect(formatCost(1.5)).toBe('$1.50');
  });

  it('maps statuses to tones and shortens ids', () => {
    expect(statusTone('failed')).toBe('err');
    expect(statusTone('degraded')).toBe('warn');
    expect(statusTone('whatever')).toBe('neutral');
    expect(shortId(EX)).toBe('ex_bbbbbbbb');
  });

  it('parses JSON input with readable errors', () => {
    expect(parseJsonInput('')).toEqual({ ok: true, value: {} });
    expect(parseJsonInput('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    const bad = parseJsonInput('{a:1}');
    expect(bad.ok).toBe(false);
  });

  it('pre-validates tokens with the same rule as the server', () => {
    expect(looksLikeToken('oat_abcdefghijklmnop')).toBe(true);
    expect(looksLikeToken('short')).toBe(false);
    expect(looksLikeToken('has spaces in the token value')).toBe(false);
  });
});
