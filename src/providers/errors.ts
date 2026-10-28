import { redactString } from '../lib/redact.js';

export type ProviderErrorCode =
  | 'not_configured'
  | 'unsupported_capability'
  | 'invalid_input'
  | 'blocked_url'
  | 'timeout'
  | 'rate_limited'
  | 'auth_failed'
  | 'bad_request'
  | 'not_found'
  | 'upstream_error'
  | 'network_error'
  | 'malformed_response'
  | 'refused'
  | 'quota_exceeded' // provider credit/plan limit reached: not retried, but fallback-eligible
  | 'cancelled';

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set([
  'timeout',
  'rate_limited',
  'upstream_error',
  'network_error',
]);

/**
 * Normalized provider error. Every adapter maps its native failures into this shape so the
 * manager can apply one retry/fallback policy. Messages are redacted on construction.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    public readonly code: ProviderErrorCode,
    public readonly provider: string,
    message: string,
    public readonly options: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(redactString(message));
    this.name = 'ProviderError';
    this.retryable = RETRYABLE.has(code);
  }

  toJSON() {
    return {
      code: this.code,
      provider: this.provider,
      message: this.message,
      retryable: this.retryable,
      ...(this.options.status !== undefined ? { status: this.options.status } : {}),
    };
  }
}

/** Map an HTTP status from any provider to a normalized code. */
export function codeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 404) return 'not_found';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  return 'bad_request';
}

/** Parse Retry-After (seconds or HTTP date). Capped to avoid unbounded sleeps. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, 60_000);
}
