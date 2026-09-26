import { randomBytes } from 'node:crypto';
import { getRedis } from './redis.js';

/**
 * Operator session epoch.
 *
 * The dashboard's session cookie carries this value. Bumping it invalidates every
 * cookie issued so far, which is how a password change or a suspected compromise
 * is revoked without waiting for the cookie TTL to lapse.
 *
 * The web service reads this same key to verify cookies. The two packages cannot
 * share code across the service boundary, so `web/lib/server/session.ts`
 * implements the identical read path against this exact key name — if you change
 * it here, change it there.
 */
export const OPERATOR_EPOCH_KEY = 'op:sess:epoch';

const GENERATED_BYTES = 16;

/**
 * Returns the current epoch, creating it on first use.
 *
 * A missing key is seeded with a random value rather than a constant. That makes
 * a Redis flush fail closed: previously issued cookies carry the old epoch and
 * stop verifying, rather than resurrecting revoked sessions.
 */
export async function ensureOperatorSessionEpoch(): Promise<string> {
  const redis = await getRedis();
  const existing = await redis.get(OPERATOR_EPOCH_KEY);
  if (existing) return existing;
  const fresh = randomBytes(GENERATED_BYTES).toString('hex');
  // NX so concurrent callers converge on a single winner; the loser re-reads.
  await redis.set(OPERATOR_EPOCH_KEY, fresh, { NX: true });
  return (await redis.get(OPERATOR_EPOCH_KEY)) ?? fresh;
}

export async function bumpOperatorSessionEpoch(): Promise<string> {
  const redis = await getRedis();
  return String(await redis.incr(OPERATOR_EPOCH_KEY));
}
