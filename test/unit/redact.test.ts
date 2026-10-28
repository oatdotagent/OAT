import { describe, expect, it } from 'vitest';
import { redactString, redactValue, registerSecrets } from '../../src/lib/redact.js';

describe('redaction', () => {
  it('scrubs registered secret values verbatim', () => {
    registerSecrets(['custom-secret-value-123']);
    expect(redactString('error: key custom-secret-value-123 rejected')).toBe('error: key [REDACTED] rejected');
  });

  it('scrubs known credential formats', () => {
    const s = redactString('sk-ant-api03-abcdefghijk and ghp_abcdefghijklmnopqrstuvwxyz012345 and jina_abcdefghijklmnop1234');
    expect(s).not.toMatch(/sk-ant-api03|ghp_|jina_abc/);
  });

  it('keeps the scheme but scrubs bearer tokens and key=value pairs', () => {
    expect(redactString('Authorization: Bearer abc.def.ghi123')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactString('url?api_key=supersecret123&x=1')).toBe('url?api_key=[REDACTED]&x=1');
  });

  it('redacts sensitive keys in nested objects', () => {
    const out = redactValue({ headers: { authorization: 'Bearer x', other: 'ok' }, nested: [{ apiKey: 'k', privateKey: 'p' }] });
    expect(out).toEqual({ headers: { authorization: '[REDACTED]', other: 'ok' }, nested: [{ apiKey: '[REDACTED]', privateKey: '[REDACTED]' }] });
  });

  it('redacts 32-byte hex strings (private-key shaped)', () => {
    expect(redactString(`0x${'ab'.repeat(32)}`)).toBe('[REDACTED]');
  });
});
