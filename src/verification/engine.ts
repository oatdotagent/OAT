import { getPath } from '../lib/json-path.js';
import type { Criterion, VerificationSpec } from '../orchestration/definition.js';
import type { ContentSource } from '../providers/capabilities.js';
import { compileSchema, formatSchemaErrors } from './schema.js';

/**
 * Verification engine: checks a step's output against an explicit JSON Schema and declarative
 * acceptance criteria, recording each check with evidence.
 *
 * What a "passed" verification means — and does NOT mean:
 *  - It means the output conforms to the declared structure and criteria.
 *  - `urls_in_step` additionally traces cited URLs back to a retrieval step's results.
 *  - It never means the factual claims in the content are true. `factualClaimsVerified` is
 *    always false because no check here establishes truth; the summary says so explicitly.
 */

export interface CheckResult {
  name: string;
  type: string;
  passed: boolean;
  message: string;
  description?: string;
  evidence?: unknown;
}

export interface Assessment {
  contentSource: ContentSource;
  provider: string;
  isMock: boolean;
  structuralStatus: 'conforms' | 'does_not_conform' | 'no_checks_declared';
  groundingStatus: 'not_checked' | 'citations_traced' | 'citations_untraced';
  factualClaimsVerified: false;
  summary: string;
}

export interface VerificationOutcome {
  status: 'passed' | 'failed' | 'error';
  checks: CheckResult[];
  assessment: Assessment;
}

export interface VerifyParams {
  output: unknown;
  spec: VerificationSpec;
  contentSource: ContentSource;
  provider: string;
  isMock: boolean;
  /** Outputs of completed steps, used by grounding checks. */
  stepOutputs: Record<string, unknown>;
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/g;
const MAX_EVIDENCE_CHARS = 300;

function preview(v: unknown): unknown {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return null;
  return s.length > MAX_EVIDENCE_CHARS ? `${s.slice(0, MAX_EVIDENCE_CHARS)}…` : v;
}

function normalizeUrl(u: string): string {
  try {
    const url = new URL(u.replace(/[.,;:!?]+$/, ''));
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return u;
  }
}

function collectUrls(value: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === 'string') for (const m of v.matchAll(URL_RE)) out.push(normalizeUrl(m[0]));
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(value);
  return [...new Set(out)];
}

function runCriterion(c: Criterion, output: unknown, stepOutputs: Record<string, unknown>): CheckResult {
  const base = { name: `${c.type}:${c.path}`, type: c.type, ...(c.description ? { description: c.description } : {}) };
  const { found, value } = getPath(output, c.path);

  switch (c.type) {
    case 'required': {
      const ok = found && value !== null && value !== undefined && value !== '';
      return { ...base, passed: ok, message: ok ? 'value present' : 'value missing or empty', evidence: { found, value: preview(value) } };
    }
    case 'min_items':
    case 'max_items': {
      if (!Array.isArray(value)) return { ...base, passed: false, message: 'value is not an array', evidence: { found } };
      const ok = c.type === 'min_items' ? value.length >= c.min : value.length <= c.max;
      const bound = c.type === 'min_items' ? `>= ${c.min}` : `<= ${c.max}`;
      return { ...base, passed: ok, message: `array length ${value.length} (expected ${bound})`, evidence: { length: value.length } };
    }
    case 'string_length': {
      if (typeof value !== 'string') return { ...base, passed: false, message: 'value is not a string', evidence: { found } };
      const ok = (c.min === undefined || value.length >= c.min) && (c.max === undefined || value.length <= c.max);
      return { ...base, passed: ok, message: `string length ${value.length}`, evidence: { length: value.length } };
    }
    case 'contains':
    case 'not_contains': {
      if (typeof value !== 'string') return { ...base, passed: false, message: 'value is not a string', evidence: { found } };
      const hay = c.caseSensitive ? value : value.toLowerCase();
      const needle = c.caseSensitive ? c.value : c.value.toLowerCase();
      const idx = hay.indexOf(needle);
      const ok = c.type === 'contains' ? idx !== -1 : idx === -1;
      return {
        ...base,
        passed: ok,
        message: c.type === 'contains' ? (ok ? 'substring found' : 'substring not found') : ok ? 'substring absent' : 'forbidden substring found',
        evidence: idx !== -1 ? { position: idx, excerpt: value.slice(Math.max(0, idx - 40), idx + needle.length + 40) } : { position: -1 },
      };
    }
    case 'equals': {
      const ok = found && value === c.value;
      return { ...base, passed: ok, message: ok ? 'value matches' : 'value differs', evidence: { expected: c.value, actual: preview(value) } };
    }
    case 'number_range': {
      if (typeof value !== 'number') return { ...base, passed: false, message: 'value is not a number', evidence: { found } };
      const ok = (c.min === undefined || value >= c.min) && (c.max === undefined || value <= c.max);
      return { ...base, passed: ok, message: `value ${value}`, evidence: { value, min: c.min ?? null, max: c.max ?? null } };
    }
    case 'urls_in_step': {
      const cited = collectUrls(found ? value : undefined);
      const source = stepOutputs[c.sourceStep];
      if (source === undefined) {
        return { ...base, passed: false, message: `source step "${c.sourceStep}" has no output`, evidence: { cited } };
      }
      const allowed = new Set(collectUrls(getPath(source, c.sourcePath).value));
      const matched = cited.filter((u) => allowed.has(u));
      const unmatched = cited.filter((u) => !allowed.has(u));
      const ok = unmatched.length === 0 && cited.length >= c.minUrls;
      return {
        ...base,
        passed: ok,
        message: ok
          ? `all ${cited.length} cited URL(s) appear in "${c.sourceStep}" results`
          : cited.length < c.minUrls
            ? `found ${cited.length} cited URL(s), expected at least ${c.minUrls}`
            : `${unmatched.length} cited URL(s) not found in "${c.sourceStep}" results`,
        evidence: { sourceStep: c.sourceStep, matched, unmatched, sourceUrlCount: allowed.size },
      };
    }
  }
}

export function verifyOutput(p: VerifyParams): VerificationOutcome {
  const checks: CheckResult[] = [];
  try {
    if (p.spec.schema) {
      const compiled = compileSchema(p.spec.schema);
      if (!compiled.ok) {
        checks.push({ name: 'json_schema', type: 'json_schema', passed: false, message: compiled.error });
      } else {
        const ok = compiled.validate(p.output) as boolean;
        checks.push({
          name: 'json_schema',
          type: 'json_schema',
          passed: ok,
          message: ok ? 'output conforms to schema' : 'output violates schema',
          ...(ok ? {} : { evidence: { errors: formatSchemaErrors(compiled.validate) } }),
        });
      }
    }
    for (const c of p.spec.criteria) checks.push(runCriterion(c, p.output, p.stepOutputs));
  } catch (err) {
    return {
      status: 'error',
      checks,
      assessment: buildAssessment(p, checks, `Verification could not complete: ${(err as Error).message}`),
    };
  }
  const passed = checks.every((c) => c.passed);
  return { status: passed ? 'passed' : 'failed', checks, assessment: buildAssessment(p, checks) };
}

function buildAssessment(p: VerifyParams, checks: CheckResult[], errorNote?: string): Assessment {
  const grounding = checks.filter((c) => c.type === 'urls_in_step');
  const groundingStatus: Assessment['groundingStatus'] =
    grounding.length === 0 ? 'not_checked' : grounding.every((c) => c.passed) ? 'citations_traced' : 'citations_untraced';
  const structuralStatus: Assessment['structuralStatus'] =
    checks.length === 0 ? 'no_checks_declared' : checks.every((c) => c.passed) ? 'conforms' : 'does_not_conform';

  const parts: string[] = [];
  if (errorNote) parts.push(errorNote);
  if (p.isMock) parts.push('Output came from the MOCK provider and is not real data.');
  parts.push(
    structuralStatus === 'conforms'
      ? 'Output conforms to the declared schema and acceptance criteria.'
      : structuralStatus === 'no_checks_declared'
        ? 'No verification checks were declared for this step.'
        : `${checks.filter((c) => !c.passed).length} of ${checks.length} check(s) failed.`,
  );
  if (groundingStatus === 'citations_traced') {
    parts.push('Cited URLs were traced to retrieved results; this shows where citations came from, not that the sources support the claims.');
  }
  parts.push(
    p.contentSource === 'model_generated'
      ? 'Content is model-generated; its factual claims have NOT been independently verified.'
      : `Content is data as reported by provider "${p.provider}" and has not been independently verified.`,
  );

  return {
    contentSource: p.contentSource,
    provider: p.provider,
    isMock: p.isMock,
    structuralStatus,
    groundingStatus,
    factualClaimsVerified: false,
    summary: parts.join(' '),
  };
}
