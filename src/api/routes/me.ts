import type { FastifyPluginAsync } from 'fastify';
import { can, type Permission } from '../../auth/auth.js';
import { requireAuth, sendData } from '../http.js';

const ALL_PERMISSIONS: Permission[] = [
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
];

/** Identity of the caller, so clients can adapt the UI to their role. Never returns credentials. */
export const meRoutes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (req, reply) => {
    const auth = requireAuth(req);
    return sendData(reply, {
      userId: auth.userId,
      role: auth.role,
      devBypass: auth.devBypass,
      permissions: ALL_PERMISSIONS.filter((p) => can(auth, p)),
    });
  });
};
