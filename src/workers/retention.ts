import { config } from '../config.js';
import { storeRepo } from '../db/repos.js';
import { purgeStorePii } from '../services/pdpl.js';
import { logger } from '../lib/logger.js';
import { withLock } from '../lib/lock.js';

const RETENTION_INTERVAL_MS = 6 * 60 * 60_000;
const LOCK_TTL_MS = 600_000;
// Upper bound on lease renewal. Purging walks every store's PII, so it scales
// with the tenant count — generous, but finite.
const MAX_DURATION_MS = 60 * 60_000;

export function startRetentionWorker(): { stop(): void } {
  if (!config.retentionEnabled) {
    logger.info('retention: disabled via RETENTION_ENABLED');
    return { stop: () => {} };
  }
  const tick = async () => {
    await withLock(
      'worker:retention',
      LOCK_TTL_MS,
      async () => {
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
      },
      { maxDurationMs: MAX_DURATION_MS },
    );
  };
  tick().catch((err) => logger.error({ err }, 'retention tick error'));
  const handle = setInterval(() => tick().catch((err) => logger.error({ err }, 'retention tick error')), RETENTION_INTERVAL_MS);
  return { stop: () => clearInterval(handle) };
}