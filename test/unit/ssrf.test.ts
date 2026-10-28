import { describe, expect, it } from 'vitest';
import { assertPublicUrl, BlockedUrlError, isBlockedIp, type LookupFn } from '../../src/lib/ssrf.js';

const resolvesTo =
  (...addresses: string[]): LookupFn =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

const policy = (lookup: LookupFn = resolvesTo('93.184.215.14'), extra = {}) => ({ allowedHosts: [], blockedHosts: [], lookup, ...extra });

describe('isBlockedIp', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1'])(
    'blocks %s',
    (ip) => expect(isBlockedIp(ip)).toBe(true),
  );
  it.each(['93.184.215.14', '8.8.8.8', '2606:4700:4700::1111'])('allows %s', (ip) => expect(isBlockedIp(ip)).toBe(false));
});

describe('assertPublicUrl', () => {
  it('allows public http(s) URLs', async () => {
    await expect(assertPublicUrl('https://example.com/page?x=1', policy())).resolves.toBeInstanceOf(URL);
  });

  it.each([
    ['file:///etc/passwd', /only http/],
    ['ftp://example.com', /only http/],
    ['http://user:pass@example.com', /credentials/],
    ['http://example.com:8080', /non-standard port/],
    ['http://localhost/', /internal hostname/],
    ['http://metadata.google.internal/', /internal hostname/],
    ['http://127.0.0.1/', /private/],
    ['http://169.254.169.254/latest/meta-data', /private/],
    ['http://[::1]/', /private/],
    ['not a url', /valid absolute URL/],
  ])('rejects %s', async (url, reason) => {
    await expect(assertPublicUrl(url, policy())).rejects.toThrow(reason);
  });

  it('rejects hostnames that resolve to private addresses (DNS rebinding style)', async () => {
    await expect(assertPublicUrl('https://evil.example.com', policy(resolvesTo('10.0.0.5')))).rejects.toThrow(BlockedUrlError);
    await expect(assertPublicUrl('https://mixed.example.com', policy(resolvesTo('93.184.215.14', '127.0.0.1')))).rejects.toThrow(/private/);
  });

  it('rejects unresolvable hosts', async () => {
    const failing: LookupFn = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(assertPublicUrl('https://nope.example.com', policy(failing))).rejects.toThrow(/did not resolve/);
  });

  it('applies allow and block lists', async () => {
    await expect(assertPublicUrl('https://docs.example.com', policy(undefined, { allowedHosts: ['example.com'] }))).resolves.toBeDefined();
    await expect(assertPublicUrl('https://other.org', policy(undefined, { allowedHosts: ['example.com'] }))).rejects.toThrow(/allowlist/);
    await expect(assertPublicUrl('https://bad.example.com', policy(undefined, { blockedHosts: ['bad.example.com'] }))).rejects.toThrow(/blocked/);
  });
});
