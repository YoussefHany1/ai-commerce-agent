import { runAllAutomation } from '../services/automation.js';
import { logger } from '../lib/logger.js';
import { withLock } from '../lib/lock.js';

const POLL_INTERVAL_MS = 30_000;
const LOCK_TTL_MS = 120_000;
// Upper bound on lease renewal. Automation calls the LLM per rule, so a slow
// tick is normal — but not an unbounded one.
const MAX_DURATION_MS = 10 * 60_000;

// Belt and braces with the Redis lease: the lease excludes other replicas, this
// flag stops a slow tick being re-entered by the next interval in this process.
let running = false;

export function startAutomationWorker(): { stop(): void } {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await withLock('worker:automation', LOCK_TTL_MS, () => runAllAutomation(), {
        maxDurationMs: MAX_DURATION_MS,
      });
      if (summary && (summary.rulesEvaluated > 0 || summary.actionsSent > 0))
        logger.info(
          {
            evaluated: summary.rulesEvaluated,
            sent: summary.actionsSent,
            failed: summary.actionsFailed,
            skipped: summary.rulesSkipped,
          },
          'automation tick',
        );
    } catch (err) {
      logger.error({ err }, 'automation tick error');
    } finally {
      running = false;
    }
  };
  tick().catch((err) => logger.error({ err }, 'automation tick error'));
  const handle = setInterval(() => tick().catch((err) => logger.error({ err }, 'automation tick error')), POLL_INTERVAL_MS);
  return { stop: () => clearInterval(handle) };
}