import { describe, expect, it } from 'vitest';
import { validateWorkflowDefinition } from '../../src/orchestration/validate.js';

const step = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  capability: 'web.search',
  input: { query: 'x' },
  ...extra,
});

describe('validateWorkflowDefinition', () => {
  it('computes parallel stages from dependencies', () => {
    const r = validateWorkflowDefinition({
      name: 'wf',
      steps: [step('a'), step('b'), step('c', { dependsOn: ['a', 'b'], input: { query: '{{steps.a.output.results[0].title}}' } })],
    });
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.stages).toEqual([['a', 'b'], ['c']]);
  });

  it('detects cycles, unknown and self dependencies', () => {
    const cyc = validateWorkflowDefinition({ name: 'wf', steps: [step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })] });
    expect(cyc.valid).toBe(false);
    expect(cyc.errors.map((e) => e.message).join()).toMatch(/cycle/);

    const unknown = validateWorkflowDefinition({ name: 'wf', steps: [step('a', { dependsOn: ['zzz', 'a'] })] });
    expect(unknown.errors.map((e) => e.message)).toEqual(expect.arrayContaining(['unknown step "zzz"', 'a step cannot depend on itself']));
  });

  it('requires template references to point at declared dependencies', () => {
    const r = validateWorkflowDefinition({
      name: 'wf',
      steps: [step('a'), step('b', { input: { query: '{{steps.a.output.results[0].title}}' } })],
    });
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.message).toMatch(/not a \(transitive\) dependency/);
  });

  it('rejects duplicate ids, unknown capabilities and too many steps', () => {
    expect(validateWorkflowDefinition({ name: 'wf', steps: [step('a'), step('a')] }).errors[0]!.message).toMatch(/duplicate/);
    expect(validateWorkflowDefinition({ name: 'wf', steps: [step('a', { capability: 'shell.exec' })] }).valid).toBe(false);
    expect(validateWorkflowDefinition({ name: 'wf', steps: Array.from({ length: 51 }, (_, i) => step(`s${i}`)) }).valid).toBe(false);
  });

  it('validates verification specs and schemas', () => {
    const bad = validateWorkflowDefinition({
      name: 'wf',
      inputSchema: { type: 'object', properties: { q: { type: 'string', pattern: '(a+)+$' } } },
      steps: [
        step('a', {
          verification: { schema: { type: 'nonsense' }, criteria: [{ type: 'urls_in_step', path: 'text', sourceStep: 'zzz' }] },
        }),
      ],
    });
    const msgs = bad.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    expect(msgs).toMatch(/verification\.schema: invalid JSON Schema/);
    expect(msgs).toMatch(/sourceStep "zzz" must be a dependency/);
    expect(msgs).toMatch(/inputSchema: keyword "pattern" is not allowed/);
  });
});
