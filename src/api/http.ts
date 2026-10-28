import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can, type AuthContext, type Permission } from '../auth/auth.js';
import { AppError, badRequest, forbidden, unauthorized } from '../lib/errors.js';

/** Success envelope: `{ data, meta: { requestId, ... } }`. Errors use `{ error, meta }` (see error handler). */
export function sendData(reply: FastifyReply, data: unknown, opts: { status?: number; meta?: Record<string, unknown> } = {}) {
  return reply.status(opts.status ?? 200).send({ data, meta: { requestId: reply.request.id, ...opts.meta } });
}

export function parseWith<T extends z.ZodType>(schema: T, value: unknown, what = 'request'): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw badRequest(
      `Invalid ${what}`,
      r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
    );
  }
  return r.data;
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

export function requirePermission(req: FastifyRequest, permission: Permission): AuthContext {
  const auth = requireAuth(req);
  if (!can(auth, permission)) {
    req.server.repos.audit({
      actorId: auth.userId,
      action: 'authz.denied',
      requestId: req.id,
      outcome: 'denied',
      details: { permission, route: req.routeOptions.url },
    });
    throw forbidden(`Missing permission ${permission}`);
  }
  return auth;
}

export const idParam = (prefix: string) =>
  z.object({ id: z.string().regex(new RegExp(`^${prefix}_[a-f0-9]{32}$`), 'invalid id') });

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export function pageMeta(page: { limit: number; offset: number }, total: number) {
  return { page: { limit: page.limit, offset: page.offset, total, hasMore: page.offset + page.limit < total } };
}

export { AppError };
