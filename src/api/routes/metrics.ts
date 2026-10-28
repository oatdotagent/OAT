import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { pageQuery, parseWith, requirePermission, sendData } from '../http.js';

const metricsQuery = z.object({ windowHours: z.coerce.number().int().min(1).max(24 * 30).default(24) });

/** Operational metrics and audit trail (admin only). */
export const metricsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/metrics', async (req, reply) => {
    requirePermission(req, 'metrics:read');
    const { windowHours } = parseWith(metricsQuery, req.query, 'query');
    const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
    return sendData(reply, {
      window: { hours: windowHours, since },
      http: app.httpMetrics.snapshot(),
      providers: {
        // estimatedCostUsd is null when no provider-reported or published per-token price is known.
        byCapability: app.repos.providerStats(since),
        errors: app.repos.providerErrorBreakdown(since),
      },
      executions: { byStatus: app.repos.executionStatusCounts(since), coordinator: app.coordinator.stats() },
    });
  });

  app.get('/audit-events', async (req, reply) => {
    requirePermission(req, 'audit:read');
    const page = parseWith(pageQuery, req.query, 'query');
    return sendData(reply, app.repos.listAudit(page), { meta: { page } });
  });
};
