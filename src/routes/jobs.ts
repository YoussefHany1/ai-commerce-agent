import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { jobsRepo } from '../db/repos.js';
import { resolveHandler } from '../workers/jobs.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { requireOperator, requireDashboard } from '../lib/auth.js';
import { config } from '../config.js';

const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };
const storeIdRef = (req: any) =>
  ((req as any).params as { storeId?: string })?.storeId ?? ((req as any).body as { storeId?: string })?.storeId;

const TYPES = ['catalog.sync', 'order.sync', 'embedding.backfill', 'metrics.rollup', 'retention.purge'] as const;

export async function jobs(app: FastifyInstance) {
  app.post(
    '/api/jobs',
    { preHandler: [requireDashboard(storeIdRef, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const body = z
        .object({
          storeId: z.string().uuid(),
          type: z.enum(TYPES),
          payload: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(req.body);
      const id = await jobsRepo.enqueue(body.storeId, body.type, body.payload ?? {});
      return { id, enqueued: !!id };
    },
  );

  app.get('/api/jobs/:storeId', { preHandler: [requireDashboard(storeIdRef, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] }, async (req) => {
    const { storeId } = z.object({ storeId: z.string().uuid() }).parse(req.params);
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    return { storeId, jobs: await jobsRepo.list(storeId, q.status) };
  });

  app.post(
    '/api/jobs/:jobId/retry',
    { preHandler: [requireDashboard(storeIdRef, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const { jobId } = z.object({ jobId: z.string().min(1) }).parse(req.params);
      const body = z.object({ storeId: z.string().uuid() }).parse(req.body);
      const ok = await jobsRepo.retry(body.storeId, jobId);
      if (!ok) throw Object.assign(new Error('job_not_found'), { statusCode: 404 });
      return { ok: true };
    },
  );

  app.post(
    '/api/jobs/run',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const body = z
        .object({
          storeId: z.string().uuid(),
          type: z.enum(TYPES),
          payload: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(req.body);
      // Single-layer control — an operator can force any job synchronously. The
      // only serialize-on-write here is the type allowlist above and the
      // Object.hasOwn lookup in resolveHandler; retention.purge stays gated on
      // the same flag the worker honors, or this route would bypass the kill switch.
      const fn = resolveHandler(body.type);
      if (body.type === 'retention.purge' && !config.retentionEnabled) {
        // resolveHandler already ran, but retention.purge must respect the kill switch.
        throw Object.assign(new Error('retention_disabled'), { statusCode: 409 });
      }
      await fn(body.storeId, body.payload ?? {});
      return { ok: true };
    },
  );
}
