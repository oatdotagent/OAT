import { describe, expect, it } from 'vitest';
import { validateWorkflowDefinition } from '../../src/orchestration/validate.js';
import { compileSchema } from '../../src/verification/schema.js';
import { sampleInput, TEMPLATES } from '../../web/src/console/templates.js';

/** The console's starter templates must always be accepted by the real backend validator. */
describe('console workflow templates', () => {
  it.each(TEMPLATES.map((t) => [t.id, t] as const))('%s validates against the backend', (_id, t) => {
    const r = validateWorkflowDefinition(t.definition);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('sample inputs have the declared property names', () => {
    for (const t of TEMPLATES) {
      const schema = (t.definition as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema;
      const sample = sampleInput(schema);
      expect(Object.keys(sample)).toEqual(Object.keys(schema?.properties ?? {}));
      if (schema) expect(compileSchema(schema).ok).toBe(true);
    }
  });
});
