import { runAllAutomation } from '../services/automation.js';
import { logger } from '../lib/logger.js';

const POLL_INTERVAL_MS = 30_000;
let running = false;

export function startAutomationWorker(): { stop(): void } {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const summary = await runAllAutomation();
      if (summary.rulesEvaluated > 0 || summary.actionsSent > 0)
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