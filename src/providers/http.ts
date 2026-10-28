import { ProviderError, codeForStatus, parseRetryAfter } from './errors.js';
import type { FetchFn, InvokeContext } from './types.js';

const MAX_RESPONSE_BYTES = 10 * 1_048_576;

export interface JsonRequest {
  provider: string;
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  fetchImpl: FetchFn;
  ctx: InvokeContext;
}

/**
 * Shared HTTP helper for REST adapters: per-attempt timeout, cancellation, status → error
 * normalization, Retry-After parsing, response-size cap and JSON parsing. Request headers
 * (which carry credentials) are never included in thrown errors.
 */
export async function requestJson(req: JsonRequest): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(req.ctx.timeoutMs);
  const signal = AbortSignal.any([req.ctx.signal, timeoutSignal]);
  let res: Response;
  try {
    res = await req.fetchImpl(req.url, {
      method: req.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...req.headers,
      },
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal,
      redirect: 'error',
    });
  } catch (err) {
    if (req.ctx.signal.aborted) throw new ProviderError('cancelled', req.provider, 'Request cancelled');
    if (timeoutSignal.aborted) {
      throw new ProviderError('timeout', req.provider, `Request timed out after ${req.ctx.timeoutMs}ms`);
    }
    throw new ProviderError('network_error', req.provider, `Network error: ${(err as Error).message}`);
  }

  const declaredLength = Number(res.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new ProviderError('malformed_response', req.provider, 'Response exceeds size limit');
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    if (timeoutSignal.aborted) {
      throw new ProviderError('timeout', req.provider, `Response body timed out after ${req.ctx.timeoutMs}ms`);
    }
    throw new ProviderError('network_error', req.provider, `Failed reading response: ${(err as Error).message}`);
  }
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new ProviderError('malformed_response', req.provider, 'Response exceeds size limit');
  }

  if (!res.ok) {
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    // Include a short slice of the body for diagnosis; ProviderError redacts it.
    const snippet = text.slice(0, 300).replace(/\s+/g, ' ');
    throw new ProviderError(codeForStatus(res.status), req.provider, `HTTP ${res.status}: ${snippet}`, {
      status: res.status,
      retryAfterMs,
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError('malformed_response', req.provider, 'Response was not valid JSON');
  }
}
