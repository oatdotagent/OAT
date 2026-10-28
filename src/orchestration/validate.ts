import { compileSchema } from '../verification/schema.js';
import { parsePath } from '../lib/json-path.js';
import { isCapability } from '../providers/capabilities.js';
import { workflowDefinitionSchema, type WorkflowDefinition } from './definition.js';
import { extractRefs } from './template.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ReadinessCheck {
  stepId: string;
  capability: string;
  provider: string | null;
  ready: boolean;
  allowed: boolean;
  /** Why the step can't run (missing setting or permission); null when it can. */
  reason: string | null;
}

export interface WorkflowValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  /** Topologically ordered stages; steps in the same stage may run in parallel. */
  stages: string[][];
  definition?: WorkflowDefinition;
}

/** Structural + semantic validation of a workflow definition (no provider calls). */
export function validateWorkflowDefinition(raw: unknown): WorkflowValidationResult {
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      stages: [],
      errors: parsed.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
    };
  }
  const def = parsed.data;
  const errors: ValidationIssue[] = [];
  const ids = new Set<string>();
  def.steps.forEach((s, i) => {
    if (ids.has(s.id)) errors.push({ path: `steps.${i}.id`, message: `duplicate step id "${s.id}"` });
    ids.add(s.id);
  });

  const deps = new Map<string, Set<string>>();
  def.steps.forEach((s, i) => {
    const set = new Set<string>();
    for (const d of s.dependsOn) {
      if (d === s.id) errors.push({ path: `steps.${i}.dependsOn`, message: 'a step cannot depend on itself' });
      else if (!ids.has(d)) errors.push({ path: `steps.${i}.dependsOn`, message: `unknown step "${d}"` });
      else set.add(d);
    }
    deps.set(s.id, set);
  });

  const stages = topoStages(def, deps, errors);
  const ancestors = computeAncestors(def, deps);

  def.steps.forEach((s, i) => {
    if (!isCapability(s.capability)) errors.push({ path: `steps.${i}.capability`, message: 'unknown capability' });
    try {
      for (const ref of extractRefs(s.input)) {
        if (ref.root === 'steps' && !ancestors.get(s.id)?.has(ref.stepId)) {
          errors.push({
            path: `steps.${i}.input`,
            message: `references steps.${ref.stepId} which is not a (transitive) dependency of "${s.id}"`,
          });
        }
      }
    } catch (err) {
      errors.push({ path: `steps.${i}.input`, message: (err as Error).message });
    }

    const v = s.verification;
    if (v?.schema) {
      const c = compileSchema(v.schema);
      if (!c.ok) errors.push({ path: `steps.${i}.verification.schema`, message: c.error });
    }
    v?.criteria.forEach((c, j) => {
      const base = `steps.${i}.verification.criteria.${j}`;
      try {
        parsePath(c.path);
        if (c.type === 'urls_in_step') {
          parsePath(c.sourcePath);
          if (!ancestors.get(s.id)?.has(c.sourceStep)) {
            errors.push({ path: base, message: `sourceStep "${c.sourceStep}" must be a dependency of "${s.id}"` });
          }
        }
      } catch (err) {
        errors.push({ path: base, message: (err as Error).message });
      }
    });
  });

  if (def.inputSchema) {
    const c = compileSchema(def.inputSchema);
    if (!c.ok) errors.push({ path: 'inputSchema', message: c.error });
  }

  return { valid: errors.length === 0, errors, stages: errors.length === 0 ? stages : [], definition: def };
}

function topoStages(def: WorkflowDefinition, deps: Map<string, Set<string>>, errors: ValidationIssue[]): string[][] {
  const remaining = new Map([...deps].map(([k, v]) => [k, new Set(v)]));
  const stages: string[][] = [];
  while (remaining.size > 0) {
    const ready = def.steps.map((s) => s.id).filter((id) => remaining.get(id)?.size === 0);
    if (ready.length === 0) {
      errors.push({ path: 'steps', message: `dependency cycle among: ${[...remaining.keys()].join(', ')}` });
      return [];
    }
    stages.push(ready);
    for (const id of ready) remaining.delete(id);
    for (const set of remaining.values()) for (const id of ready) set.delete(id);
  }
  return stages;
}

function computeAncestors(def: WorkflowDefinition, deps: Map<string, Set<string>>): Map<string, Set<string>> {
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (stack.has(id)) return new Set(); // cycle — reported by topoStages
    stack.add(id);
    const out = new Set<string>();
    for (const d of deps.get(id) ?? []) {
      out.add(d);
      for (const a of visit(d, stack)) out.add(a);
    }
    stack.delete(id);
    memo.set(id, out);
    return out;
  };
  for (const s of def.steps) visit(s.id, new Set());
  return memo;
}
