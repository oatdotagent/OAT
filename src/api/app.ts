import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import { Authenticator, type AuthContext } from '../auth/auth.js';
import type { Env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { redactString } from '../lib/redact.js';
import type { LookupFn } from '../lib/ssrf.js';
import { HttpMetrics } from '../observability/http-metrics.js';
import { WorkflowCoordinator } from '../orchestration/coordinator.js';
import type { ProviderManager } from '../providers/manager.js';
import { buildProviderManager } from '../providers/registry.js';
import type { FetchFn } from '../providers/types.js';
import type { Database } from '../storage/db.js';
import { Repositories } from '../storage/repositories.js';
import { executionRoutes } from './routes/executions.js';
import { healthRoutes } from './routes/health.js';
import { meRoutes } from './routes/me.js';
import { metricsRoutes } from './routes/metrics.js';
import { providerRoutes } from './routes/providers.js';
import { verificationRoutes } from './routes/verifications.js';
import { workflowRoutes } from './routes/workflows.js';

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    repos: Repositories;
    providers: ProviderManager;
    coordinator: WorkflowCoordinator;
    httpMetrics: HttpMetrics;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyContextConfig {
    /** Route is reachable without authentication. */
    public?: boolean;
  }
}

export interface AppDeps {
  env: Env;
  db: Database;
  /** Test seams: inject fetch/DNS/sleep so automated tests never hit real networks. */
  fetchImpl?: FetchFn;
  lookup?: LookupFn;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  providers?: ProviderManager;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,128}$/;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { env } = deps;
  const app = Fastify({
    bodyLimit: env.BODY_LIMIT_BYTES,
    trustProxy: env.TRUST_PROXY,
    // Built-in request logs are replaced by the redacted access log in the onResponse hook.
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : randomUUID();
    },
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'headers.authorization',
          '*.apiKey',
          '*.token',
          '*.password',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        err: (err: Error & { code?: string }) => ({
          type: err.name,
          code: err.code,
          message: redactString(err.message ?? ''),
          stack: err.stack ? redactString(err.stack) : '',
        }),
      },
    },
  });

  const repos = new Repositories(deps.db, env.MAX_STORED_OUTPUT_BYTES);
  const providers =
    deps.providers ??
    buildProviderManager(env, {
      fetchImpl: deps.fetchImpl,
      lookup: deps.lookup,
      sleep: deps.sleep,
      onRetry: (retry) => app.log.warn(retry, 'provider attempt failed, retrying'),
      onCall: (record) => {
        try {
          repos.recordProviderCall(record);
        } catch (err) {
          app.log.warn({ err }, 'failed to persist provider call record');
        }
        app.log.info(
          {
            provider: record.provider,
            capability: record.capability,
            status: record.status,
            errorCode: record.errorCode,
            latencyMs: record.latencyMs,
            attempts: record.attempts,
            executionId: record.executionId,
          },
          'provider call',
        );
      },
    });
  const coordinator = new WorkflowCoordinator({
    repos,
    providers,
    logger: app.log,
    maxConcurrentExecutions: env.MAX_CONCURRENT_EXECUTIONS,
    executionTimeoutMs: env.EXECUTION_TIMEOUT_MS,
  });
  const httpMetrics = new HttpMetrics();
  const authenticator = new Authenticator(env.AUTH_TOKENS, env.AUTH_DEV_BYPASS && env.NODE_ENV !== 'production');

  app.decorate('env', env);
  app.decorate('repos', repos);
  app.decorate('providers', providers);
  app.decorate('coordinator', coordinator);
  app.decorate('httpMetrics', httpMetrics);
  app.decorateRequest('auth', null);

  // Only JSON bodies are accepted.
  app.removeContentTypeParser('text/plain');

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        // Same-origin only; no inline scripts. HTTPS upgrade only in production (local dev is plain HTTP).
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null,
      },
    },
  });
  await app.register(cors, {
    origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after'],
    credentials: false,
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    // Static frontend assets are not rate limited; every API route is.
    allowList: (req) => !req.url.startsWith('/api/'),
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    // Key by credential (hashed) when present so users behind one IP don't share a bucket.
    keyGenerator: (req) => {
      const h = req.headers.authorization;
      return typeof h === 'string' && h.length > 0 ? `tok:${createHash('sha256').update(h).digest('hex').slice(0, 32)}` : `ip:${req.ip}`;
    },
    errorResponseBuilder: (req, ctx) => {
      const err = new AppError('rate_limited', `Rate limit exceeded; retry in ${Math.ceil(ctx.ttl / 1000)}s`, 429);
      return Object.assign(err, { requestId: req.id });
    },
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    req.auth = authenticator.authenticate(req.headers.authorization);
    if (!req.routeOptions.config.public && req.headers.authorization && !req.auth) {
      // A credential was presented but did not match: reject early, uniformly.
      throw new AppError('unauthorized', 'Invalid credentials', 401);
    }
  });

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    httpMetrics.observe(req.method, route, reply.statusCode, reply.elapsedTime);
    req.log.info(
      {
        requestId: req.id,
        method: req.method,
        route,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        userId: req.auth?.userId,
      },
      'request completed',
    );
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    let status = 500;
    let code = 'internal_error';
    let message = 'Internal server error';
    let details: unknown;

    if (err instanceof AppError) {
      status = err.statusCode;
      code = err.code;
      message = err.message;
      details = err.details;
    } else if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      status = 413;
      code = 'payload_too_large';
      message = `Request body exceeds ${env.BODY_LIMIT_BYTES} bytes`;
    } else if (err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      status = 415;
      code = 'unsupported_media_type';
      message = 'Content-Type must be application/json';
    } else if (err.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || err.code === 'FST_ERR_CTP_INVALID_JSON_BODY' || err instanceof SyntaxError) {
      status = 400;
      code = 'invalid_json';
      message = 'Request body is not valid JSON';
    } else if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      status = err.statusCode;
      code = 'bad_request';
      message = redactString(err.message);
    }

    if (status >= 500) req.log.error({ err, requestId: req.id }, 'unhandled error');
    else req.log.debug({ code, requestId: req.id }, 'request rejected');

    return reply.status(status).send({
      error: { code, message, ...(details !== undefined ? { details } : {}) },
      meta: { requestId: req.id },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'Route not found' }, meta: { requestId: req.id } }),
  );

  await app.register(
    async (v1) => {
      await v1.register(healthRoutes);
      await v1.register(meRoutes);
      await v1.register(providerRoutes);
      await v1.register(workflowRoutes);
      await v1.register(executionRoutes);
      await v1.register(verificationRoutes);
      await v1.register(metricsRoutes);
    },
    { prefix: '/api/v1' },
  );

  // Same-origin frontend (landing page + console), when it has been built.
  const webRoot = resolve(env.WEB_DIST_DIR);
  if (env.SERVE_WEB && existsSync(resolve(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      wildcard: true, // serves files per request; the plugin only walks the folder with glob when this is false
      index: ['index.html'],
      redirect: true,
      dotfiles: 'deny',
      setHeaders: (reply, filePath) => {
        // Vite emits content-hashed files under /assets; everything else must revalidate.
        const hashed = /[\\/]assets[\\/]/.test(filePath);
        reply.header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.addHook('onClose', async () => {
    await coordinator.shutdown();
  });

  return app;
}
