import { randomBytes } from 'node:crypto';
import { getRedis } from './redis.js';
import { logger } from './logger.js';

const PREFIX = 'lock:';

/**
 * Release only if we still hold the lease. Without the token comparison, a slow
 * tick that already lost its lease could delete a lock a different replica has
 * since acquired.
 */
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end`;

/** Extend only if we still hold it, so a lost lease is never silently reclaimed. */
const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end`;

export type Lock = {
  /** Extend the lease. Returns false once the lease has been lost. */
  renew(): Promise<boolean>;
  release(): Promise<void>;
};

/**
 * Cross-replica mutual exclusion for the background workers.
 *
 * Every worker starts on every API replica, so without this each tick runs N
 * times concurrently: duplicate LLM spend on automations, duplicate rollup
 * writes, and a retention purge racing itself. A lease in Redis means exactly one
 * replica runs a given worker per tick regardless of how many are deployed.
 *
 * The lease is renewed while the work runs. If renewal fails — a Redis blip, or
 * an event-loop stall long enough for the lease to lapse — two replicas can
 * briefly overlap. The work is written to tolerate that (idempotent writes,
 * per-store try/catch), so overlap degrades throughput rather than correctness.
 */
export async function acquireLock(name: string, ttlMs: number): Promise<Lock | null> {
  const key = `${PREFIX}${name}`;
  const token = randomBytes(16).toString('hex');
  const redis = await getRedis();

  // set() resolves to null when NX rejects the write, i.e. someone else holds it.
  const acquired = await redis.set(key, token, { NX: true, PX: ttlMs });
  if (acquired === null) return null;

  return {
    async renew(): Promise<boolean> {
      try {
        const res = await redis.eval(RENEW_SCRIPT, { keys: [key], arguments: [token, String(ttlMs)] });
        return res === 1;
      } catch (err) {
        logger.warn({ err, lock: name }, 'lock renewal failed');
        return false;
      }
    },
    async release(): Promise<void> {
      try {
        await redis.eval(RELEASE_SCRIPT, { keys: [key], arguments: [token] });
      } catch (err) {
        // Best effort: the lease expires on its own, and a failure here must not
        // mask the error that caused the work to unwind.
        logger.warn({ err, lock: name }, 'lock release failed');
      }
    },
  };
}

/**
 * Runs `fn` under the named lease, or returns null without running it when
 * another replica holds the lock.
 */
/**
 * Runs `fn` under the named lease, or returns null without running it when
 * another replica holds the lock.
 *
 * `maxDurationMs` is a hard ceiling on how long the lease may be renewed. Without
 * it, work that never settles — a half-open TCP connection, an upstream that
 * accepts and then stalls — keeps its lease alive indefinitely, and the worker is
 * dead for every replica at once. When the ceiling trips, renewal stops so the
 * lease lapses on its own and another replica can take over; the pending work is
 * left to unwind on its own (with the fetch deadlines in `lib/http.ts` it will).
 */
export async function withLock<T>(
  name: string,
  ttlMs: number,
  fn: () => Promise<T>,
  opts: { maxDurationMs?: number } = {},
): Promise<T | null> {
  const lock = await acquireLock(name, ttlMs);
  if (!lock) return null;

  // Renew at a third of the lease, so two renewals can fail before the lease
  // actually lapses. The floor keeps a long-running worker from hammering Redis,
  // but it is clamped to half the TTL: without that clamp a short lease would
  // schedule its first renewal *after* it had already expired, and the holder
  // would silently lose mutual exclusion.
  const renewEvery = Math.min(Math.max(1_000, Math.floor(ttlMs / 3)), Math.floor(ttlMs / 2));
  const timer = setInterval(() => void lock.renew(), Math.max(1, renewEvery));
  timer.unref?.();

  let guard: NodeJS.Timeout | null = null;
  if (opts.maxDurationMs !== undefined) {
    guard = setTimeout(() => {
      clearInterval(timer);
      logger.error(
        { lock: name, maxDurationMs: opts.maxDurationMs },
        'lock renewal stopped: work exceeded its hard deadline, releasing the lease',
      );
    }, opts.maxDurationMs);
    guard.unref?.();
  }

  try {
    return await fn();
  } finally {
    clearInterval(timer);
    if (guard) clearTimeout(guard);
    await lock.release();
  }
}
