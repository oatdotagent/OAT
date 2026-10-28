import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hashToken } from '../src/auth/auth.js';

/**
 * Generates an API token for a client and the AUTH_TOKENS entry to configure on the server.
 * Only the hash is stored server-side.
 *
 *   npm run token:create -- <userId> [admin|user]
 *   npm run token:create -- --owner=<userId> [--role=admin|user] [--out=<file>]
 *
 * With --out, the raw token is written only to that file (never printed) and stdout contains just
 * the AUTH_TOKENS entry. The file must not already exist, so an existing token is never overwritten.
 */
const USAGE = 'usage: npm run token:create -- <userId> [admin|user]\n       npm run token:create -- --owner=<userId> [--role=admin|user] [--out=<file>]';

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(1);
}

const flags = new Map<string, string>();
const positional: string[] = [];
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--(owner|role|out)=(.*)$/);
  if (m) {
    if (flags.has(m[1]!)) fail(`duplicate option --${m[1]}`);
    flags.set(m[1]!, m[2]!);
  } else if (arg.startsWith('-')) fail(`unknown option ${arg.split('=')[0]}`);
  else positional.push(arg);
}
if (positional.length > 0 && (flags.has('owner') || flags.has('role'))) fail('use either positional arguments or --owner/--role, not both');
if (positional.length > 2) fail('too many arguments');

const userId = flags.get('owner') ?? positional[0] ?? 'user1';
const role = flags.get('role') ?? positional[1] ?? 'user';
if (!/^[A-Za-z0-9_.-]{1,64}$/.test(userId)) fail(`invalid userId "${userId}" (letters, digits, "_", "." and "-" only)`);
if (!['admin', 'user'].includes(role)) fail(`invalid role "${role}"`);

const outPath = flags.get('out');
if (outPath !== undefined) {
  if (!outPath) fail('--out needs a file path');
  if (existsSync(resolve(outPath))) fail(`refusing to overwrite existing file ${outPath}`);
}

const token = `oat_${randomBytes(32).toString('base64url')}`;
const entry = `${userId}:${role}:${hashToken(token)}`;

if (outPath) {
  const file = resolve(outPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  console.error(`Token for ${userId} written to ${file} (not printed). AUTH_TOKENS entry on stdout.`);
  console.log(entry);
} else {
  console.log(`Token for ${userId} (store securely, shown once):\n  ${token}\n`);
  console.log(`Add to AUTH_TOKENS (comma-separated):\n  ${entry}`);
}
