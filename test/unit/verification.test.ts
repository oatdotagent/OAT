import { describe, expect, it } from 'vitest';
import { verificationSpecSchema } from '../../src/orchestration/definition.js';
import { verifyOutput, type VerifyParams } from '../../src/verification/engine.js';

const spec = (raw: unknown) => verificationSpecSchema.parse(raw);
const run = (output: unknown, rawSpec: unknown, extra: Partial<VerifyParams> = {}) =>
  verifyOutput({ output, spec: spec(rawSpec), contentSource: 'model_generated', provider: 'anthropic', isMock: false, stepOutputs: {}, ...extra });

describe('verification engine', () => {
  it('passes conforming output but never claims factual verification', () => {
    const r = run(
      { text: 'Paris is the capital of France.', model: 'm', stopReason: 'end_turn' },
      { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength: 5 } } }, criteria: [{ type: 'contains', path: 'text', value: 'paris' }] },
    );
    expect(r.status).toBe('passed');
    expect(r.checks.map((c) => c.passed)).toEqual([true, true]);
    expect(r.assessment).toMatchObject({ structuralStatus: 'conforms', factualClaimsVerified: false, contentSource: 'model_generated' });
    expect(r.assessment.summary).toMatch(/NOT been independently verified/);
  });

  it('records failed checks with evidence', () => {
    const r = run({ results: [] }, {
      schema: { type: 'object', properties: { results: { type: 'array', minItems: 1 } } },
      criteria: [
        { type: 'min_items', path: 'results', min: 2 },
        { type: 'required', path: 'summary' },
        { type: 'number_range', path: 'results', min: 0 },
      ],
    });
    expect(r.status).toBe('failed');
    const schemaCheck = r.checks.find((c) => c.type === 'json_schema')!;
    expect(schemaCheck.passed).toBe(false);
    expect(schemaCheck.evidence).toMatchObject({ errors: [{ path: '/results' }] });
    expect(r.checks.find((c) => c.type === 'min_items')).toMatchObject({ passed: false, evidence: { length: 0 } });
    expect(r.checks.find((c) => c.type === 'number_range')).toMatchObject({ passed: false, message: 'value is not a number' });
    expect(r.assessment.structuralStatus).toBe('does_not_conform');
  });

  it('supports equals, string_length and not_contains', () => {
    const r = run({ a: 'ok', b: 'hello world' }, {
      criteria: [
        { type: 'equals', path: 'a', value: 'ok' },
        { type: 'string_length', path: 'b', min: 1, max: 5 },
        { type: 'not_contains', path: 'b', value: 'WORLD' },
      ],
    });
    expect(r.checks.map((c) => c.passed)).toEqual([true, false, false]);
  });

  it('traces cited URLs back to a retrieval step (grounding) with evidence', () => {
    const stepOutputs = { search: { results: [{ url: 'https://a.com/x' }, { url: 'https://b.com/' }] } };
    const ok = run({ text: 'See https://a.com/x and https://b.com.' }, { criteria: [{ type: 'urls_in_step', path: 'text', sourceStep: 'search' }] }, { stepOutputs });
    expect(ok.status).toBe('passed');
    expect(ok.assessment.groundingStatus).toBe('citations_traced');
    expect(ok.assessment.factualClaimsVerified).toBe(false);
    expect(ok.assessment.summary).toMatch(/not that the sources support the claims/);

    const bad = run({ text: 'Source: https://made-up.example/' }, { criteria: [{ type: 'urls_in_step', path: 'text', sourceStep: 'search' }] }, { stepOutputs });
    expect(bad.status).toBe('failed');
    expect(bad.checks[0]!.evidence).toMatchObject({ unmatched: ['https://made-up.example'] });
    expect(bad.assessment.groundingStatus).toBe('citations_untraced');

    const none = run({ text: 'no links' }, { criteria: [{ type: 'urls_in_step', path: 'text', sourceStep: 'search', minUrls: 1 }] }, { stepOutputs });
    expect(none.status).toBe('failed');
  });

  it('labels provider data and mock output honestly', () => {
    const r = run({ results: [] }, {}, { contentSource: 'provider_data', provider: 'mock', isMock: true });
    expect(r.assessment.structuralStatus).toBe('no_checks_declared');
    expect(r.assessment.summary).toMatch(/MOCK provider/);
    expect(r.assessment.summary).toMatch(/as reported by provider "mock"/);
  });

  it('refuses unsafe schemas rather than running them', () => {
    const r = run({ a: 'x' }, { schema: { type: 'object', properties: { a: { type: 'string', pattern: '(a+)+$' } } } });
    expect(r.status).toBe('failed');
    expect(r.checks[0]!.message).toMatch(/pattern/);
  });
});
