import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { canAccessOwned, canUseCapability, ownerScope, type AuthContext } from '../../auth/auth.js';
import { AppError, notFound } from '../../lib/errors.js';
import type { WorkflowDefinition } from '../../orchestration/definition.js';
import { validateWorkflowDefinition, type ReadinessCheck } from '../../orchestration/validate.js';
import { isCapability } from '../../providers/capabilities.js';
import type { WorkflowRecord } from '../../storage/repositories.js';
import { compileSchema, formatSchemaErrors } from '../../verification/schema.js';
import { idParam, pageMeta, pageQuery, parseWith, requirePermission, sendData } from '../http.js';

const wfId = idParam('wf');
const executeBody = z.object({ input: z.unknown().optional() }).strict();
const validateBody = z.object({ input: z.unknown().optional() }).strict().optional();

/** Per-step runtime readiness: is the capability allowed for the caller and servable by a configured provider? */
function readiness(app: FastifyInstance, def: WorkflowDefinition, auth: AuthContext): ReadinessCheck[] {
  return def.steps.map((s) => {
    const ready = isCapability(s.capability) && app.providers.canServe(s.capability, s.provider);
    const allowed = canUseCapability(auth, s.capability, app.env.USER_ALLOWED_CAPABILITIES);
    return {
      stepId: s.id,
      capability: s.capability,
      provider: s.provider ?? null,
      ready,
      allowed,
      reason: !allowed
        ? `Your role may not use ${s.capability}`
        : ready
          ? null
          : isCapability(s.capability)
            ? app.providers.unavailableReason(s.capability, s.provider)
            : 'Unknown capability',
    };
  });
}

function validateInput(def: WorkflowDefinition, input: unknown) {
  if (!def.inputSchema) return { ok: true as const, errors: [] };
  const compiled = compileSchema(def.inputSchema);
  if (!compiled.ok) return { ok: false as const, errors: [{ path: 'inputSchema', message: compiled.error }] };
  const ok = compiled.validate(input ?? {}) as boolean;
  return ok ? { ok: true as const, errors: [] } : { ok: false as const, errors: formatSchemaErrors(compiled.validate) };
}

function present(w: WorkflowRecord) {
  return {
    id: w.id,
    ownerId: w.ownerId,
    name: w.name,
    description: w.description,
    version: w.version,
    definition: w.definition,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

export const workflowRoutes: FastifyPluginAsync = async (app) => {
  const loadOwned = (id: string, auth: AuthContext) => {
    const wf = app.repos.getWorkflow(id);
    if (!wf || !canAccessOwned(auth, wf.ownerId)) throw notFound('Workflow');
    return wf;
  };

  // Validate a draft definition without saving it.
  app.post('/workflows/validate', async (req, reply) => {
    const auth = requirePermission(req, 'workflows:read');
    const result = validateWorkflowDefinition(req.body);
    return sendData(reply, {
      valid: result.valid,
      errors: result.errors,
      stages: result.stages,
      readiness: result.definition && result.valid ? readiness(app, result.definition, auth) : [],
    });
  });

  app.post('/workflows', async (req, reply) => {
    const auth = requirePermission(req, 'workflows:write');
    const result = validateWorkflowDefinition(req.body);
    if (!result.valid || !result.definition) {
      throw new AppError('invalid_workflow', 'Workflow definition is invalid', 422, result.errors);
    }
    const denied = readiness(app, result.definition, auth).filter((r) => !r.allowed);
    if (denied.length > 0) {
      app.repos.audit({ actorId: auth.userId, action: 'workflow.create', requestId: req.id, outcome: 'denied', details: { denied } });
      throw new AppError('forbidden', 'Workflow uses capabilities you are not permitted to use', 403, denied);
    }
    const wf = app.repos.createWorkflow(auth.userId, result.definition);
    app.repos.audit({ actorId: auth.userId, action: 'workflow.create', resourceType: 'workflow', resourceId: wf.id, requestId: req.id, outcome: 'success' });
    return sendData(reply, { ...present(wf), stages: result.stages }, { status: 201 });
  });

  app.get('/workflows', async (req, reply) => {
    const auth = requirePermission(req, 'workflows:read');
    const page = parseWith(pageQuery, req.query, 'query');
    const { items, total } = app.repos.listWorkflows(ownerScope(auth), page);
    return sendData(reply, items.map(present), { meta: pageMeta(page, total) });
  });

  app.get('/workflows/:id', async (req, reply) => {
    const auth = requirePermission(req, 'workflows:read');
    const { id } = parseWith(wfId, req.params, 'path parameters');
    return sendData(reply, present(loadOwned(id, auth)));
  });

  // Re-validate a stored workflow against current provider configuration (and optionally a sample input).
  app.post('/workflows/:id/validate', async (req, reply) => {
    const auth = requirePermission(req, 'workflows:read');
    const { id } = parseWith(wfId, req.params, 'path parameters');
    const body = parseWith(validateBody, req.body ?? undefined, 'body');
    const wf = loadOwned(id, auth);
    const structural = validateWorkflowDefinition(wf.definition);
    const checks = structural.valid ? readiness(app, wf.definition, auth) : [];
    const inputResult = body && 'input' in body ? validateInput(wf.definition, body.input) : null;
    const executable =
      structural.valid && checks.every((c) => c.ready && c.allowed) && (inputResult === null || inputResult.ok);
    return sendData(reply, {
      workflowId: wf.id,
      valid: structural.valid,
      executable,
      errors: structural.errors,
      stages: structural.stages,
      readiness: checks,
      input: inputResult,
    });
  });

  app.post(
    '/workflows/:id/executions',
    { config: { rateLimit: { max: app.env.EXECUTION_RATE_LIMIT_MAX, timeWindow: app.env.RATE_LIMIT_WINDOW_MS } } },
    async (req, reply) => {
      const auth = requirePermission(req, 'executions:run');
      const { id } = parseWith(wfId, req.params, 'path parameters');
      const body = parseWith(executeBody, req.body ?? {}, 'body');
      const wf = loadOwned(id, auth);

      const inputResult = validateInput(wf.definition, body.input);
      if (!inputResult.ok) throw new AppError('invalid_input', 'Execution input does not match inputSchema', 422, inputResult.errors);

      const checks = readiness(app, wf.definition, auth);
      const denied = checks.filter((c) => !c.allowed);
      if (denied.length > 0) {
        app.repos.audit({ actorId: auth.userId, action: 'execution.start', resourceType: 'workflow', resourceId: wf.id, requestId: req.id, outcome: 'denied', details: { denied } });
        throw new AppError('forbidden', 'Workflow uses capabilities you are not permitted to use', 403, denied);
      }
      const notReady = checks.filter((c) => !c.ready);
      if (notReady.length > 0) {
        throw new AppError('providers_unavailable', 'No configured provider for one or more steps', 409, notReady.map((c) => ({ ...c, message: c.reason })));
      }

      const execution = app.repos.createExecution({ workflow: wf, ownerId: auth.userId, input: body.input ?? {}, requestId: req.id });
      app.repos.audit({
        actorId: auth.userId,
        action: 'execution.start',
        resourceType: 'execution',
        resourceId: execution.id,
        requestId: req.id,
        outcome: 'success',
        details: { workflowId: wf.id },
      });
      app.coordinator.start(execution, wf, req.id);
      return sendData(reply, { id: execution.id, workflowId: wf.id, status: execution.status, links: { self: `/api/v1/executions/${execution.id}` } }, { status: 202 });
    },
  );
};
