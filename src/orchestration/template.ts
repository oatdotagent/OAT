import { getPath, parsePath } from '../lib/json-path.js';

/**
 * Template references inside step inputs:
 *   {{input.query}}                         → execution input
 *   {{steps.search.output.results[0].url}}  → output of a completed dependency
 * A string that is exactly one reference resolves to the raw value (arrays/objects kept);
 * references embedded in longer strings are stringified.
 */

const TEMPLATE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
const STEP_REF_RE = /^steps\.([A-Za-z][A-Za-z0-9_]{0,63})\.output(.*)$/;
const MAX_RESOLVED_STRING = 200_000;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

export type TemplateRef = { root: 'input'; path: string } | { root: 'steps'; stepId: string; path: string };

export function parseRef(expr: string): TemplateRef {
  if (expr === 'input' || expr.startsWith('input.') || expr.startsWith('input[')) {
    const path = expr.slice('input'.length).replace(/^\./, '');
    parsePath(path);
    return { root: 'input', path };
  }
  const m = expr.match(STEP_REF_RE);
  if (m?.[1] !== undefined) {
    const path = (m[2] ?? '').replace(/^\./, '');
    if (m[2] && !m[2].startsWith('.') && !m[2].startsWith('[')) throw new TemplateError(`Invalid reference "${expr}"`);
    parsePath(path);
    return { root: 'steps', stepId: m[1], path };
  }
  throw new TemplateError(`Invalid reference "${expr}" (expected input.* or steps.<id>.output.*)`);
}

/** All references in a (nested) value, for static validation. */
export function extractRefs(value: unknown): TemplateRef[] {
  const refs: TemplateRef[] = [];
  walk(value, (s) => {
    for (const m of s.matchAll(TEMPLATE_RE)) refs.push(parseRef(m[1]!));
  });
  return refs;
}

function walk(value: unknown, onString: (s: string) => void): void {
  if (typeof value === 'string') onString(value);
  else if (Array.isArray(value)) value.forEach((v) => walk(v, onString));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => walk(v, onString));
}

export interface TemplateContext {
  input: unknown;
  steps: Record<string, { output: unknown }>;
}

function lookup(ref: TemplateRef, ctx: TemplateContext, expr: string): unknown {
  let root: unknown;
  if (ref.root === 'input') root = ctx.input;
  else {
    const step = ctx.steps[ref.stepId];
    if (!step) throw new TemplateError(`Step "${ref.stepId}" has no output available`);
    root = step.output;
  }
  const { found, value } = getPath(root, ref.path);
  if (!found || value === undefined) throw new TemplateError(`Reference "${expr}" did not resolve`);
  return value;
}

export function resolveTemplates(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (whole?.[1]) return lookup(parseRef(whole[1]), ctx, whole[1]);
    const out = value.replace(TEMPLATE_RE, (_m, expr: string) => {
      const v = lookup(parseRef(expr), ctx, expr);
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
    if (out.length > MAX_RESOLVED_STRING) throw new TemplateError('Resolved value exceeds size limit');
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, ctx));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, ctx)]));
  }
  return value;
}
