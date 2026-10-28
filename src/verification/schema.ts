import { createHash } from 'node:crypto';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

/**
 * JSON Schema compilation for user-supplied schemas (workflow input + step output contracts).
 * Untrusted schemas are constrained: size-capped, no remote $ref loading, and no regex keywords
 * (`pattern`, `patternProperties`) because user regexes can stall the event loop (ReDoS).
 */

const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as unknown as (
  ajv: Ajv,
  opts: { mode: 'fast' | 'full'; formats: string[] },
) => Ajv;

const MAX_SCHEMA_BYTES = 64 * 1024;
const FORBIDDEN_KEYWORDS = new Set(['pattern', 'patternProperties', '$dynamicRef', '$recursiveRef']);

const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: true, addUsedSchema: false });
addFormats(ajv, { mode: 'fast', formats: ['date', 'date-time', 'email', 'uri', 'uuid', 'ipv4', 'ipv6'] });

const cache = new Map<string, ValidateFunction>();
const CACHE_LIMIT = 500;

function findForbidden(node: unknown, depth = 0): string | null {
  if (depth > 32) return 'schema nesting too deep';
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findForbidden(v, depth + 1);
      if (r) return r;
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (FORBIDDEN_KEYWORDS.has(k)) return `keyword "${k}" is not allowed`;
      if (k === '$ref' && typeof v === 'string' && !v.startsWith('#')) return 'only local $ref ("#/...") is allowed';
      const r = findForbidden(v, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

export function compileSchema(schema: unknown): { ok: true; validate: ValidateFunction } | { ok: false; error: string } {
  const json = JSON.stringify(schema);
  if (json === undefined || json.length > MAX_SCHEMA_BYTES) return { ok: false, error: 'schema too large' };
  const forbidden = findForbidden(schema);
  if (forbidden) return { ok: false, error: forbidden };
  const key = createHash('sha256').update(json).digest('hex');
  const cached = cache.get(key);
  if (cached) return { ok: true, validate: cached };
  try {
    // Strip $id so user schemas cannot register themselves globally.
    const { $id: _ignored, ...rest } = schema as Record<string, unknown>;
    const validate = ajv.compile(rest);
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, validate);
    return { ok: true, validate };
  } catch (err) {
    return { ok: false, error: `invalid JSON Schema: ${(err as Error).message}` };
  }
}

export function formatSchemaErrors(validate: ValidateFunction, limit = 20): Array<{ path: string; message: string }> {
  return (validate.errors ?? []).slice(0, limit).map((e) => ({
    path: e.instancePath || '(root)',
    message: e.message ?? 'invalid',
  }));
}
