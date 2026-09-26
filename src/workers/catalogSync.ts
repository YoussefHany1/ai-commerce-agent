import { jobsRepo, connectionRepo } from '../db/repos.js';
import { logger } from '../lib/logger.js';
import { withLock } from '../lib/lock.js';

const SYNC_INTERVAL_MS = 5 * 60_000;
const LOCK_TTL_MS = 60_000;
// Upper bound on how long the lease may be renewed. This tick only enqueues, so
// anything past a few minutes means a hung dependency, not real work.
const MAX_DURATION_MS = 5 * 60_000;

export function startCatalogSync(): { stop(): void } {
  const tick = async () => {
    await withLock(
      'worker:catalog-sync',
      LOCK_TTL_MS,
      async () => {
        const dueBefore = new Date(Date.now() - SYNC_INTERVAL_MS);
        const due = await connectionRepo.listDue(dueBefore);
        for (const { storeId } of due) {
          try {
            await jobsRepo.enqueue(storeId, 'catalog.sync', {}, { runAt: new Date() });
          } catch (err) {
            logger.error({ storeId, err }, 'catalog sync enqueue failed');
          }
        }
      },
      { maxDurationMs: MAX_DURATION_MS },
    );
  };
  tick().catch((err) => logger.error({ err }, 'catalog sync tick error'));
  const handle = setInterval(() => tick().catch((err) => logger.error({ err }, 'catalog sync tick error')), SYNC_INTERVAL_MS);
  return { stop: () => clearInterval(handle) };
}