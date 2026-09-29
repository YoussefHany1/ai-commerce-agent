import { getRedis } from './redis.js';

/**
 * Escalating login lockout, shared by the operator and client logins.
 *
 * The two logins each key their counters differently — the operator by IP (there
 * is one account, so IP is the only spray axis), a client by IP *and* account
 * (so a spray across accounts still trips the IP bucket, and a focused attack on
 * one account trips its own bucket). The mechanics are identical, so they live
 * here rather than being copied.
 *
 * Thresholds are deliberately powers-of-two off: the base lock is 30s and doubles
 * every failure past the fifth, so a spray costs an attacker progressively more
 * while a mistyped password costs one lockout, not a permanent ban.
 */
export const FAIL_THRESHOLD = 5;
export const LOCK_BASE_MS = 30_000;
export const LOCK_MAX_MS = 15 * 60_000;
/** How long consecutive-failure history is remembered after a lock lapses. */
export const FAIL_MEMORY_SEC = 3600;

export function retryAfter(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

export async function lockRemainingMs(lockKey: string): Promise<number> {
  const redis = await getRedis();
  const ttl = await redis.pTTL(lockKey);
  return ttl > 0 ? ttl : 0;
}

/**
 * Records a failed attempt and returns how long the caller is now locked out for.
 * Throws on Redis failure — the caller's contract is to convert that into a 503,
 * never an unchecked free attempt.
 */
export async function recordFailure(failKey: string, lockKey: string): Promise<number> {
  const redis = await getRedis();
  const fails = await redis.incr(failKey);
  if (fails === 1) await redis.expire(failKey, FAIL_MEMORY_SEC);
  if (fails < FAIL_THRESHOLD) return 0;
  const over = fails - FAIL_THRESHOLD;
  const ms = Math.min(LOCK_BASE_MS * 2 ** over, LOCK_MAX_MS);
  await redis.set(lockKey, String(fails), { PX: ms });
  return ms;
}

export async function clearFailures(failKey: string, lockKey: string): Promise<void> {
  const redis = await getRedis();
  await redis.del([failKey, lockKey]);
}