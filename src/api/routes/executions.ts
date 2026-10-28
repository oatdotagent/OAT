import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { canAccessOwned, ownerScope, type AuthContext } from '../../auth/auth.js';
import { conflict, notFound } from '../../lib/errors.js';
import { idParam, pageMeta, pageQuery, parseWith, requirePermission, sendData } from '../http.js';

const exId = idParam('ex');
const listQuery = pageQuery.extend({
  workflowId: z.string().regex(/^wf_[a-f0-9]{32}$/).optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']).optional(),
});

export const executionRoutes: FastifyPluginAsync = async (app) => {
  const loadOwned = (id: string, auth: AuthContext) => {
    const ex = app.repos.getExecution(id);
    if (!ex || !canAccessOwned(auth, ex.ownerId)) throw notFound('Execution');
    return ex;
  };

  app.get('/executions', async (req, reply) => {
    const auth = requirePermission(req, 'executions:read');
    const q = parseWith(listQuery, req.query, 'query');
    const { items, total } = app.repos.listExecutions(
      { ownerId: ownerScope(auth), workflowId: q.workflowId, status: q.status },
      { limit: q.limit, offset: q.offset },
    );
    // List view omits inputs; fetch a single execution for full detail.
    const data = items.map(({ input: _input, ...rest }) => rest);
    return sendData(reply, data, { meta: pageMeta(q, total) });
  });

  app.get('/executions/:id', async (req, reply) => {
    const auth = requirePermission(req, 'executions:read');
    const { id } = parseWith(exId, req.params, 'path parameters');
    const ex = loadOwned(id, auth);
    const steps = app.repos.listStepRuns(ex.id);
    return sendData(reply, { ...ex, steps });
  });

  app.post('/executions/:id/cancel', async (req, reply) => {
    const auth = requirePermission(req, 'executions:cancel');
    const { id } = parseWith(exId, req.params, 'path parameters');
    const ex = loadOwned(id, auth);
    if (!app.coordinator.cancel(ex.id)) throw conflict(`Execution is not active (status: ${ex.status})`);
    app.repos.audit({ actorId: auth.userId, action: 'execution.cancel', resourceType: 'execution', resourceId: ex.id, requestId: req.id, outcome: 'success' });
    return sendData(reply, { id: ex.id, cancelRequested: true }, { status: 202 });
  });
};
