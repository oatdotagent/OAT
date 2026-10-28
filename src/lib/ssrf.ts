import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF guard for user-supplied URLs (web.extract and any future browser/fetch capability).
 * Rejects non-HTTP(S) schemes, embedded credentials, non-standard ports, internal hostnames,
 * and any hostname that resolves to a private, loopback, link-local or otherwise reserved address.
 */

export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export interface SsrfPolicy {
  allowedHosts: string[];
  blockedHosts: string[];
  lookup?: LookupFn;
}

export class BlockedUrlError extends Error {
  constructor(reason: string) {
    super(`URL rejected: ${reason}`);
    this.name = 'BlockedUrlError';
  }
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local incl. cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

export function isBlockedIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (ipv4ToInt(base) & mask);
  });
}

export function isBlockedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped / translated forms: check the embedded IPv4.
  const mapped = lower.match(/^(?:::ffff:|::ffff:0:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isBlockedIPv4(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) return true; // hex-form mapped; reject conservatively
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (lower.startsWith('2001:db8')) return true; // documentation
  if (lower.startsWith('64:ff9b:')) return true; // NAT64 (could reach internal v4)
  if (lower.startsWith('2002:')) return true; // 6to4 can embed private v4
  return false;
}

export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return isBlockedIPv4(ip);
  if (v === 6) return isBlockedIPv6(ip);
  return true;
}

const hostMatches = (host: string, pattern: string) => host === pattern || host.endsWith(`.${pattern}`);

const INTERNAL_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home.arpa', 'corp'];

export async function assertPublicUrl(raw: string, policy: SsrfPolicy): Promise<URL> {
  if (raw.length > 2048) throw new BlockedUrlError('URL too long');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError('not a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError('only http and https are allowed');
  }
  if (url.username || url.password) throw new BlockedUrlError('credentials in URL are not allowed');
  if (url.port && !['80', '443'].includes(url.port)) throw new BlockedUrlError('non-standard ports are not allowed');

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new BlockedUrlError('missing host');

  const allowed = policy.allowedHosts.map((h) => h.toLowerCase());
  const blocked = policy.blockedHosts.map((h) => h.toLowerCase());
  if (blocked.some((p) => hostMatches(host, p))) throw new BlockedUrlError('host is blocked by policy');
  if (allowed.length > 0 && !allowed.some((p) => hostMatches(host, p))) {
    throw new BlockedUrlError('host is not in the allowlist');
  }

  if (isIP(host)) {
    if (isBlockedIp(host)) throw new BlockedUrlError('private or reserved IP address');
    return url;
  }
  if (!host.includes('.') || INTERNAL_SUFFIXES.some((s) => hostMatches(host, s))) {
    throw new BlockedUrlError('internal hostname');
  }

  const lookup = policy.lookup ?? defaultLookup;
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host);
  } catch {
    throw new BlockedUrlError('hostname did not resolve');
  }
  if (addresses.length === 0) throw new BlockedUrlError('hostname did not resolve');
  if (addresses.some((a) => isBlockedIp(a.address))) {
    throw new BlockedUrlError('hostname resolves to a private or reserved address');
  }
  return url;
}
