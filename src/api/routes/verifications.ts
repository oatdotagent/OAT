import type { FastifyPluginAsync } from 'fastify';
import { canAccessOwned } from '../../auth/auth.js';
import { notFound } from '../../lib/errors.js';
import { idParam, parseWith, requirePermission, sendData } from '../http.js';

const vfId = idParam('vf');

export const verificationRoutes: FastifyPluginAsync = async (app) => {
  app.get('/verifications/:id', async (req, reply) => {
    const auth = requirePermission(req, 'verifications:read');
    const { id } = parseWith(vfId, req.params, 'path parameters');
    const v = app.repos.getVerification(id);
    if (!v || !canAccessOwned(auth, v.ownerId)) throw notFound('Verification');
    return sendData(reply, v);
  });
};
