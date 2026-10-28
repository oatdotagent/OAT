import type { FastifyPluginAsync } from 'fastify';
import { latestMigrationVersion } from '../../storage/db.js';
import { sendData } from '../http.js';

const startedAt = Date.now();

/** Liveness and readiness. Public, rate-limit exempt, and deliberately free of provider/config details. */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/health', { config: { public: true, rateLimit: false } }, async (_req, reply) =>
    sendData(reply, { status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }),
  );

  app.get('/health/ready', { config: { public: true, rateLimit: false } }, async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      checks.database = { ok: app.repos.ping() };
    } catch {
      checks.database = { ok: false, detail: 'database unreachable' };
    }
    try {
      const v = app.repos.schemaVersion();
      checks.migrations = { ok: v === latestMigrationVersion, ...(v !== latestMigrationVersion ? { detail: 'pending migrations' } : {}) };
    } catch {
      checks.migrations = { ok: false, detail: 'migration state unavailable' };
    }
    const ready = Object.values(checks).every((c) => c.ok);
    return sendData(reply, { status: ready ? 'ready' : 'not_ready', checks }, { status: ready ? 200 : 503 });
  });
};
