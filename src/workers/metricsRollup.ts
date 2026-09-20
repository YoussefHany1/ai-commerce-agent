import { storeRepo } from '../db/repos.js';
import { rollupDailyMetrics } from '../services/analytics.js';
import { logger } from '../lib/logger.js';

const ROLLUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const ROLLUP_DAYS = 3;

export function startMetricsRollup(): { stop(): void } {
  const tick = async () => {
    const stores = await storeRepo.list();
    for (const s of stores) {
      try {
        await rollupDailyMetrics(s.id, ROLLUP_DAYS);
      } catch (err) {
        logger.error({ storeId: s.id, err }, 'metrics rollup failed');
      }
    }
  };
  tick().catch((err) => logger.error({ err }, 'metrics rollup tick error'));
  const handle = setInterval(() => tick().catch((err) => logger.error({ err }, 'metrics rollup tick error')), ROLLUP_INTERVAL_MS);
  return { stop: () => clearInterval(handle) };
}