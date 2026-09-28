import { jobsRepo, catalogRepo, storeRepo, orderRepo, connectionRepo } from '../db/repos.js';
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

// Re-read this much before the cursor. Platforms timestamp an order slightly
// differently from each other, so an order placed in the same second as a sync
// boundary could otherwise fall between two runs. Upsert is idempotent on
// (store_id, platform_order_id), so re-reading the overlap costs nothing.
const ORDER_OVERLAP_MS = 5 * 60_000;
// A full history walk is bounded so one huge store cannot hold a job lease
// indefinitely. Anything past the cap is picked up by the next run, because the
// cursor advances to the last order actually read rather than to the wall clock.
const ORDER_PAGE_LIMIT = 5_000;

export type OrderSyncResult = { imported: number; cursor: string | null; truncated: boolean };

/**
 * Backfills `orders` from the platform for a store, then re-rolls the days it
 * touched. This is what makes revenue non-zero for a store that installed the
 * app after it had already taken sales — previously the only writer of `orders`
 * was the orders/create|update webhook, so historical orders were never read.
 */
export async function runOrderSync(storeId: string, opts: { since?: Date } = {}): Promise<OrderSyncResult> {
  const store = await storeRepo.get(storeId);
  if (!store) throw new Error('unusable_store');
  const adapter = await getCommerceAdapter(storeId);
  if (!adapter) throw new Error('no_connection');

  const cursor = opts.since ?? (await connectionRepo.getOrdersCursor(storeId));
  const since = cursor ? new Date(cursor.getTime() - ORDER_OVERLAP_MS) : undefined;
  const fetched = await adapter.listOrders({ since, limit: ORDER_PAGE_LIMIT });

  let maxPlacedAt: Date | null = cursor ?? null;
  let minPlacedAt: Date | null = null;
  let nextCursor: Date | null = null;
  for (const o of fetched) {
    await orderRepo.upsert(storeId, o);
    if (o.placedAt) {
      if (!maxPlacedAt || o.placedAt > maxPlacedAt) maxPlacedAt = o.placedAt;
      if (!minPlacedAt || o.placedAt < minPlacedAt) minPlacedAt = o.placedAt;
    }
  }

  // The cursor is the newest order we read, not now: a truncated page must leave
  // the unread remainder reachable, and advancing to the wall clock would skip it.
  // A run that was *not* truncated is the opposite case — the platform returned
  // everything at or after `since`, so there is provably nothing unread between
  // the last order and now. Advancing to the wall clock there is what stops a
  // store whose newest order is months old from re-fetching its entire history on
  // every 15-minute tick forever.
  //
  // Known limit: this only makes progress on truncated runs for adapters that page
  // oldest-first (Shopify). Salla and Zid return newest-first, so a store with more
  // than ORDER_PAGE_LIMIT orders keeps re-reading the same newest page. Lifting that
  // needs persisted page state rather than a timestamp cursor.
  const truncated = fetched.length >= ORDER_PAGE_LIMIT;
  if (truncated && maxPlacedAt) {
    nextCursor = maxPlacedAt;
    await connectionRepo.markOrdersSynced(storeId, maxPlacedAt);
  } else {
    // Never move the cursor backwards, and never leave it unset: a null cursor
    // makes listOrdersDue match forever, which is the busy loop above.
    const now = new Date();
    const next = maxPlacedAt && maxPlacedAt > now ? maxPlacedAt : now;
    nextCursor = next;
    await connectionRepo.markOrdersSynced(storeId, next);
  }

  // Re-roll the span the backfill touched, so the dashboard reflects the import
  // without waiting for the next 6h worker tick. getDailyMetrics also re-rolls on
  // read, but only for the window it was asked for. The rollup window is measured
  // back from today, so a six-month backfill needs the full span, not the count of
  // distinct days — a sparse history has few distinct days but a long range.
  if (minPlacedAt) {
    const today = new Date();
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const spanDays = Math.ceil((startOfToday.getTime() - new Date(minPlacedAt.getFullYear(), minPlacedAt.getMonth(), minPlacedAt.getDate()).getTime()) / 86_400_000);
    await rollupDailyMetrics(storeId, Math.min(Math.max(spanDays + 1, 3), 90));
  }

  return { imported: fetched.length, cursor: nextCursor?.toISOString() ?? null, truncated };
}

export const jobHandlers: Record<string, JobHandler> = {
  'catalog.sync': runCatalogSync,
  'order.sync': async (storeId, payload) => {
    const since = payload?.since ? new Date(String(payload.since)) : undefined;
    await runOrderSync(storeId, since && !Number.isNaN(since.getTime()) ? { since } : {});
  },
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