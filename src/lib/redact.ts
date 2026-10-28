/**
 * Secret redaction for anything that may reach logs, persisted errors or API responses.
 * Two layers: (1) exact values of configured secrets, (2) generic credential patterns.
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'], // Anthropic
  [/\bjina_[A-Za-z0-9]{16,}/g, '[REDACTED]'], // Jina
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED]'], // GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [
    /\b(api[_-]?key|token|secret|password|authorization|x-subscription-token|x-api-key)(["'\s:=]+)(?!(?:Bearer|Basic)\b|\[REDACTED\])[^\s"',&]{6,}/gi,
    '$1$2[REDACTED]',
  ],
  [/\b0x[a-fA-F0-9]{64}\b/g, '[REDACTED]'], // raw 32-byte hex (e.g. private keys)
];

const knownSecrets = new Set<string>();

/** Register configured secret values so they are scrubbed verbatim wherever they appear. */
export function registerSecrets(values: Array<string | undefined>): void {
  for (const v of values) if (v && v.length >= 8) knownSecrets.add(v);
}

export function redactString(input: string): string {
  let out = input;
  for (const secret of knownSecrets) out = out.split(secret).join('[REDACTED]');
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

const SENSITIVE_KEY = /^(authorization|cookie|set-cookie|x-api-key|x-subscription-token|api[_-]?key|apikey|token|access[_-]?token|secret|password|private[_-]?key|mnemonic|seed)$/i;

/** Deep-redacts an arbitrary value (bounded depth) for safe logging/persistence. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}
