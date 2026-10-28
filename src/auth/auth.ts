import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Bearer-token authentication. Only SHA-256 hashes of tokens are configured (AUTH_TOKENS), so a
 * leaked env file does not leak usable credentials. Roles map to explicit permissions; non-admin
 * users are scoped to the resources they own.
 */

export type Role = 'admin' | 'user';

export type Permission =
  | 'workflows:read'
  | 'workflows:write'
  | 'executions:read'
  | 'executions:run'
  | 'executions:cancel'
  | 'verifications:read'
  | 'providers:read'
  | 'providers:probe'
  | 'metrics:read'
  | 'audit:read';

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  user: new Set<Permission>([
    'workflows:read',
    'workflows:write',
    'executions:read',
    'executions:run',
    'executions:cancel',
    'verifications:read',
    'providers:read',
  ]),
  admin: new Set<Permission>([
    'workflows:read',
    'workflows:write',
    'executions:read',
    'executions:run',
    'executions:cancel',
    'verifications:read',
    'providers:read',
    'providers:probe',
    'metrics:read',
    'audit:read',
  ]),
};

export interface AuthContext {
  userId: string;
  role: Role;
  /** True only for the development bypass principal. */
  devBypass: boolean;
}

export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

interface TokenEntry {
  userId: string;
  role: Role;
  hash: Buffer;
}

export class Authenticator {
  private readonly entries: TokenEntry[];

  constructor(
    tokenSpecs: string[],
    private readonly devBypass: boolean,
  ) {
    this.entries = tokenSpecs.map((spec) => {
      const [userId, role, hash] = spec.split(':') as [string, Role, string];
      return { userId, role, hash: Buffer.from(hash, 'hex') };
    });
  }

  get enabled(): boolean {
    return this.entries.length > 0;
  }

  authenticate(authorizationHeader: string | undefined): AuthContext | null {
    if (!authorizationHeader) {
      return this.devBypass && !this.enabled ? { userId: 'dev', role: 'admin', devBypass: true } : null;
    }
    const m = authorizationHeader.match(/^Bearer\s+([A-Za-z0-9._~+/=-]{16,512})$/);
    if (!m?.[1]) return null;
    const candidate = Buffer.from(hashToken(m[1]), 'hex');
    // Compare against every entry in constant time per entry; do not short-circuit on match.
    let found: TokenEntry | null = null;
    for (const e of this.entries) {
      if (timingSafeEqual(candidate, e.hash) && !found) found = e;
    }
    return found ? { userId: found.userId, role: found.role, devBypass: false } : null;
  }
}

export function can(ctx: AuthContext, permission: Permission): boolean {
  return ROLE_PERMISSIONS[ctx.role].has(permission);
}

/** null = may see every owner's records (admin); otherwise restrict to this owner. */
export function ownerScope(ctx: AuthContext): string | null {
  return ctx.role === 'admin' ? null : ctx.userId;
}

export function canAccessOwned(ctx: AuthContext, ownerId: string): boolean {
  return ctx.role === 'admin' || ctx.userId === ownerId;
}

/** Capability-level permission: admins may use any capability; users only the allowlisted ones. */
export function canUseCapability(ctx: AuthContext, capability: string, userAllowed: readonly string[]): boolean {
  return ctx.role === 'admin' || userAllowed.includes(capability);
}
