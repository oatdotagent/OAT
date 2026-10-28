/**
 * Minimal, safe path accessor used by workflow templates and verification criteria.
 * Syntax: `a.b[0].c`, `results[*].url` (wildcard maps over arrays). No eval, no regex from users.
 */

export type PathSegment = { key: string } | { index: number } | { wildcard: true };

const SEGMENT_RE = /([^.[\]]+)|\[(\d+|\*)\]/g;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function parsePath(path: string): PathSegment[] {
  if (path === '' || path === '$') return [];
  const normalized = path.startsWith('$.') ? path.slice(2) : path;
  if (
    normalized.length > 256 ||
    !/^[A-Za-z0-9_\-.[\]*]+$/.test(normalized) ||
    /^\.|\.\.|\.$|\.\[/.test(normalized)
  ) {
    throw new Error(`Invalid path "${path}"`);
  }
  const segments: PathSegment[] = [];
  let consumed = 0;
  for (const m of normalized.matchAll(SEGMENT_RE)) {
    consumed += m[0].length;
    if (m[1] !== undefined) {
      if (FORBIDDEN_KEYS.has(m[1])) throw new Error(`Forbidden path segment "${m[1]}"`);
      segments.push({ key: m[1] });
    } else if (m[2] === '*') segments.push({ wildcard: true });
    else segments.push({ index: Number(m[2]) });
  }
  const dots = (normalized.match(/\./g) ?? []).length;
  if (consumed + dots !== normalized.length) throw new Error(`Invalid path "${path}"`);
  return segments;
}

function step(values: unknown[], seg: PathSegment): unknown[] {
  const out: unknown[] = [];
  for (const v of values) {
    if ('wildcard' in seg) {
      if (Array.isArray(v)) out.push(...v);
    } else if ('index' in seg) {
      if (Array.isArray(v) && seg.index < v.length) out.push(v[seg.index]);
    } else if (v !== null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, seg.key)) {
      out.push((v as Record<string, unknown>)[seg.key]);
    }
  }
  return out;
}

/**
 * Resolve a path. Returns `{ found: false }` if any segment is missing.
 * When the path contains a wildcard the value is always an array.
 */
export function getPath(root: unknown, path: string): { found: boolean; value: unknown } {
  const segments = parsePath(path);
  const hasWildcard = segments.some((s) => 'wildcard' in s);
  let values: unknown[] = [root];
  for (const seg of segments) {
    values = step(values, seg);
    if (values.length === 0 && !hasWildcard) return { found: false, value: undefined };
  }
  if (hasWildcard) return { found: true, value: values };
  return { found: values.length > 0, value: values[0] };
}
