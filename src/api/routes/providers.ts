import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { canUseCapability } from '../../auth/auth.js';
import { capabilityDefs, capabilityNames } from '../../providers/capabilities.js';
import { requirePermission, sendData } from '../http.js';

/** Provider and capability discovery. Exposes readiness and health only — never keys or config values. */
export const providerRoutes: FastifyPluginAsync = async (app) => {
  app.get('/providers', async (req, reply) => {
    const auth = requirePermission(req, 'providers:read');
    const providers = app.providers.describe();
    const capabilities = capabilityNames.map((name) => {
      const def = capabilityDefs[name];
      return {
        name,
        description: def.description,
        contentSource: def.contentSource,
        fallbackCompatible: def.fallbackCompatible,
        available: app.providers.canServe(name),
        // Names the missing setting (e.g. "GEMINI_API_KEY is not set"), never its value.
        unavailableReason: app.providers.unavailableReason(name),
        routedTo: app.providers.routedTo(name),
        allowedForCaller: canUseCapability(auth, name, app.env.USER_ALLOWED_CAPABILITIES),
        providers: app.providers.candidates(name).map((a) => a.id),
        inputSchema: z.toJSONSchema(def.input),
        outputSchema: z.toJSONSchema(def.output),
      };
    });
    return sendData(reply, { providers, capabilities });
  });

  // Passive health from recent calls; cheap and side-effect free.
  app.get('/providers/health', async (req, reply) => {
    requirePermission(req, 'providers:read');
    const providers = app.providers.describe().map((p) => ({ id: p.id, configured: p.configured, isMock: p.isMock, ...p.health }));
    return sendData(reply, { providers });
  });

  // Active probes make outbound calls, so they are admin-only, audited and tightly rate limited.
  app.post('/providers/health/probe', { config: { rateLimit: { max: 6, timeWindow: 60_000 } } }, async (req, reply) => {
    const auth = requirePermission(req, 'providers:probe');
    const results = await app.providers.checkHealth();
    app.repos.audit({
      actorId: auth.userId,
      action: 'providers.probe',
      requestId: req.id,
      outcome: 'success',
      details: results.map((r) => ({ id: r.id, mode: r.mode, status: r.status })),
    });
    return sendData(reply, { results });
  });
};
