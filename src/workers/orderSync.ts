import { jobsRepo, connectionRepo } from '../db/repos.js';
import { logger } from '../lib/logger.js';
import { withLock } from '../lib/lock.js';

// Orders move far less often than a catalog, so this ticks less aggressively than
// catalogSync. It exists to backfill history on first sight of a connection and to
// keep picking up anything the webhooks missed.
const SYNC_INTERVAL_MS = 15 * 60_000;
const LOCK_TTL_MS = 60_000;
// Upper bound on how long the lease may be renewed. This tick only enqueues, so
// anything past a few minutes means a hung dependency, not real work.
const MAX_DURATION_MS = 5 * 60_000;

export function startOrderSync(): { stop(): void } {
  const tick = async () => {
    await withLock(
      'worker:order-sync',
      LOCK_TTL_MS,
      async () => {
        const dueBefore = new Date(Date.now() - SYNC_INTERVAL_MS);
        const due = await connectionRepo.listOrdersDue(dueBefore);
        for (const { storeId } of due) {
          try {
            await jobsRepo.enqueue(storeId, 'order.sync', {}, { runAt: new Date() });
          } catch (err) {
            logger.error({ storeId, err }, 'order sync enqueue failed');
          }
        }
      },
      { maxDurationMs: MAX_DURATION_MS },
    );
  };
  tick().catch((err) => logger.error({ err }, 'order sync tick error'));
  const handle = setInterval(() => tick().catch((err) => logger.error({ err }, 'order sync tick error')), SYNC_INTERVAL_MS);
  return { stop: () => clearInterval(handle) };
}
