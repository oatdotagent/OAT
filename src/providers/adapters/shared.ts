import type { z } from 'zod';
import { ProviderError } from '../errors.js';
import type { CapabilityName } from '../capabilities.js';

/** Validate a raw upstream payload; any mismatch becomes a normalized `malformed_response`. */
export function parseUpstream<T extends z.ZodType>(schema: T, data: unknown, provider: string): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ProviderError(
      'malformed_response',
      provider,
      `Unexpected response shape${first ? ` at ${first.path.join('.') || '(root)'}: ${first.message}` : ''}`,
    );
  }
  return result.data;
}

export function unsupported(provider: string, capability: CapabilityName): never {
  throw new ProviderError('unsupported_capability', provider, `${provider} does not implement ${capability}`);
}
