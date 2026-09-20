import { jobsRepo, connectionRepo } from '../db/repos.js';
import { logger } from '../lib/logger.js';

const SYNC_INTERVAL_MS = 5 * 60_000;

export function startCatalogSync(): { stop(): void } {
  const tick = async () => {
    const dueBefore = new Date(Date.now() - SYNC_INTERVAL_MS);
    const due = await connectionRepo.listDue(dueBefore);
    for (const { storeId } of due) {
      try {
        await jobsRepo.enqueue(storeId, 'catalog.sync', {}, { runAt: new Date() });
      } catch (err) {
        logger.error({ storeId, err }, 'catalog sync enqueue failed');
      }
    }
  };
  tick().catch((err) => logger.error({ err }, 'catalog sync tick error'));
  const handle = setInterval(() => tick().catch((err) => logger.error({ err }, 'catalog sync tick error')), SYNC_INTERVAL_MS);
  return { stop: () => clearInterval(handle) };
}