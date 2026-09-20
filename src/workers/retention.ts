import { config } from '../config.js';
import { storeRepo } from '../db/repos.js';
import { purgeStorePii } from '../services/pdpl.js';
import { logger } from '../lib/logger.js';

const RETENTION_INTERVAL_MS = 6 * 60 * 60_000;

export function startRetentionWorker(): { stop(): void } {
  if (!config.retentionEnabled) {
    logger.info('retention: disabled via RETENTION_ENABLED');
    return { stop: () => {} };
  }
  const tick = async () => {
    const stores = await storeRepo.list();
    const now = new Date();
    for (const s of stores) {
      try {
        const counts = await purgeStorePii(s.id, now);
        if (counts.total > 0)
          logger.info(
            {
              storeId: s.id,
              conversations: counts.conversations,
              attributions: counts.attributions,
              events: counts.events,
              customers: counts.customers,
            },
            'retention purge',
          );
      } catch (err) {
        logger.error({ storeId: s.id, err }, 'retention purge failed');
      }
    }
  };
  tick().catch((err) => logger.error({ err }, 'retention tick error'));
  const handle = setInterval(() => tick().catch((err) => logger.error({ err }, 'retention tick error')), RETENTION_INTERVAL_MS);
  return { stop: () => clearInterval(handle) };
}