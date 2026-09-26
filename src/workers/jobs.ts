import { jobsRepo, catalogRepo, storeRepo } from '../db/repos.js';
import { getCommerceAdapter } from '../integrations/factory.js';
import { embedMissingCatalog } from '../services/retrieval.js';
import { rollupDailyMetrics } from '../services/analytics.js';
import { purgeStorePii } from '../services/pdpl.js';
import { logger } from '../lib/logger.js';
import { withLock } from '../lib/lock.js';

const POLL_INTERVAL_MS = 3_000;
const LOCK_TTL_MS = 60_000;
// Upper bound on lease renewal. This tick drains the queue and each job makes
// third-party HTTP calls, so a busy queue legitimately runs long — but a stalled
// one must not hold the lease, and the worker, for every replica, indefinitely.
const MAX_DURATION_MS = 15 * 60_000;

export type JobHandler = (storeId: string, payload: Record<string, unknown> | null) => Promise<void>;

export async function runCatalogSync(storeId: string): Promise<void> {
  const store = await storeRepo.get(storeId);
  if (!store) throw new Error('unusable_store');
  const adapter = await getCommerceAdapter(storeId);
  if (!adapter) throw new Error('no_connection');
  const products = await adapter.listProducts();
  const nextVersion = (await catalogRepo.syncVersion(storeId)) + 1;
  await catalogRepo.upsert(storeId, products, nextVersion);
  await catalogRepo.markSynced(storeId);
}

export const jobHandlers: Record<string, JobHandler> = {
  'catalog.sync': runCatalogSync,
  'embedding.backfill': async (storeId) => {
    await embedMissingCatalog(storeId);
  },
  'metrics.rollup': async (storeId) => {
    await rollupDailyMetrics(storeId, 3);
  },
  'retention.purge': async (storeId) => {
    await purgeStorePii(storeId);
  },
};

export function resolveHandler(type: string): JobHandler {
  const fn = jobHandlers[type];
  if (!fn) throw new Error(`unknown_job_type_${type}`);
  return fn;
}

export function startJobsWorker(): { stop(): void } {
  const tick = async () => {
    // The correctness guarantee for job execution is the conditional claim inside
    // jobsRepo.run (`WHERE status = 'pending'`), so a lost race is already a no-op
    // for the loser. The lease is the coordination layer: it stops every replica
    // polling listDue — a cross-tenant scan — on the same 3s cadence, and keeps
    // concurrent claim attempts against the same rows from churning.
    await withLock(
      'worker:jobs',
      LOCK_TTL_MS,
      async () => {
        const due = await jobsRepo.listDue(new Date());
        for (const job of due) {
          try {
            const fn = resolveHandler(job.type);
            const outcome = await jobsRepo.run(job.storeId, job, () => fn(job.storeId, job.payload));
            if (outcome === 'failed') logger.warn({ storeId: job.storeId, jobType: job.type }, 'job failed');
          } catch (err) {
            logger.error({ jobId: job.id, jobType: job.type, err }, 'job dispatch error');
          }
        }
      },
      { maxDurationMs: MAX_DURATION_MS },
    );
  };
  tick().catch((err) => logger.error({ err }, 'jobs worker tick error'));
  const handle = setInterval(() => tick().catch((err) => logger.error({ err }, 'jobs worker tick error')), POLL_INTERVAL_MS);
  return { stop: () => clearInterval(handle) };
}