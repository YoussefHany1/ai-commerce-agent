import { storeRepo } from '../db/repos.js';
import { rollupDailyMetrics } from '../services/analytics.js';
import { logger } from '../lib/logger.js';
import { withLock } from '../lib/lock.js';

const ROLLUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ROLLUP_DAYS = 3;
const LOCK_TTL_MS = 300_000;
// Upper bound on lease renewal. The tick walks every store, so it scales with the
// tenant count — generous, but finite.
const MAX_DURATION_MS = 30 * 60_000;

export function startMetricsRollup(): { stop(): void } {
  const tick = async () => {
    await withLock(
      'worker:metrics-rollup',
      LOCK_TTL_MS,
      async () => {
        const stores = await storeRepo.list();
        for (const s of stores) {
          try {
            await rollupDailyMetrics(s.id, ROLLUP_DAYS);
          } catch (err) {
            logger.error({ storeId: s.id, err }, 'metrics rollup failed');
          }
        }
      },
      { maxDurationMs: MAX_DURATION_MS },
    );
  };
  tick().catch((err) => logger.error({ err }, 'metrics rollup tick error'));
  const handle = setInterval(() => tick().catch((err) => logger.error({ err }, 'metrics rollup tick error')), ROLLUP_INTERVAL_MS);
  return { stop: () => clearInterval(handle) };
}