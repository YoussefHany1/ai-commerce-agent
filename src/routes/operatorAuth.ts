import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getRedis } from '../lib/redis.js';
import { consumeRateLimit, reqIp } from '../lib/rateLimit.js';
import { verifyOperatorPassword, MAX_OPERATOR_PASSWORD_LENGTH } from '../lib/passwordHash.js';
import { ensureOperatorSessionEpoch } from '../lib/operatorSession.js';

/**
 * Operator login for the merchant dashboard.
 *
 * The dashboard is a BFF: the browser holds an HTTP-only session cookie minted by
 * the web service, and the web service calls this route to check the password
 * before doing so. Keeping verification here means the attempt counter lives in
 * Redis, so the lockout survives web restarts and redeploys and is shared across
 * web replicas.
 *
 * On success the current session epoch is returned; the caller binds it into the
 * cookie so that `scripts/revoke-operator-sessions.ts` can invalidate the session
 * server-side.
 */

const loginWindow = { limit: 20, windowSec: 60 };

const FAIL_THRESHOLD = 5;
const LOCK_BASE_MS = 30_000;
const LOCK_MAX_MS = 15 * 60_000;
/** How long consecutive-failure history is remembered after a lock lapses. */
const FAIL_MEMORY_SEC = 3600;

const FAIL_PREFIX = 'op:login:fail:';
const LOCK_PREFIX = 'op:login:lock:';

const body = z.object({ password: z.string().min(1).max(MAX_OPERATOR_PASSWORD_LENGTH) });

function retryAfter(ms: number): number {
  return Math.max(1, Math.ceil(ms / 1000));
}

async function lockRemainingMs(ip: string): Promise<number> {
  const redis = await getRedis();
  const ttl = await redis.pTTL(`${LOCK_PREFIX}${ip}`);
  return ttl > 0 ? ttl : 0;
}

/**
 * Records a failed attempt and returns how long the caller is now locked out for.
 * Lockout doubles per failure past the threshold, so a spray costs an attacker
 * progressively more time while a mistyped password costs one lockout, not a
 * permanent ban.
 */
async function recordFailure(ip: string): Promise<number> {
  const redis = await getRedis();
  const key = `${FAIL_PREFIX}${ip}`;
  const fails = await redis.incr(key);
  if (fails === 1) await redis.expire(key, FAIL_MEMORY_SEC);
  if (fails < FAIL_THRESHOLD) return 0;
  const over = fails - FAIL_THRESHOLD;
  const ms = Math.min(LOCK_BASE_MS * 2 ** over, LOCK_MAX_MS);
  await redis.set(`${LOCK_PREFIX}${ip}`, String(fails), { PX: ms });
  return ms;
}

async function clearFailures(ip: string): Promise<void> {
  const redis = await getRedis();
  await redis.del([`${FAIL_PREFIX}${ip}`, `${LOCK_PREFIX}${ip}`]);
}

export async function operatorAuth(app: FastifyInstance) {
  app.post('/api/auth/operator/verify', async (req, rep) => {
    if (!config.OPERATOR_PASSWORD_HASH) {
      return rep.code(503).send({ error: 'auth_not_configured' });
    }

    // Parse before touching Redis. A malformed or oversized body is the caller's
    // mistake and gets a 400 whether or not the session store is reachable; making
    // it depend on Redis would report a valid-looking outage for a bad request.
    // A zod failure propagates to the shared error handler as a 400.
    const { password } = body.parse(req.body ?? {});

    const ip = reqIp(req);

    // Backstop only: the escalating lockout below is the primary brake and binds
    // far sooner. This caps a spray from an IP whose lockout writes keep failing.
    // Deliberately not a preHandler — a throw there would bypass the fail-closed
    // Redis handling and surface as a 500.
    try {
      await consumeRateLimit(`ip:operator-login:${ip}`, loginWindow);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 429) throw err;
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    let locked: number;
    try {
      locked = await lockRemainingMs(ip);
    } catch {
      // Without Redis the attempt counter is unknowable. Refusing the attempt is
      // the only choice that does not turn a cache outage into unlimited login tries.
      return rep.code(503).send({ error: 'auth_unavailable' });
    }
    if (locked > 0) {
      return rep.code(429)
        .header('retry-after', String(retryAfter(locked)))
        .send({ error: 'too_many_attempts' });
    }

    let ok = await verifyOperatorPassword(password, config.OPERATOR_PASSWORD_HASH);
    if (!ok && config.OPERATOR_PASSWORD_HASH_PREVIOUS) {
      ok = await verifyOperatorPassword(password, config.OPERATOR_PASSWORD_HASH_PREVIOUS);
    }

    if (!ok) {
      let ms = 0;
      try {
        ms = await recordFailure(ip);
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      if (ms > 0) {
        return rep.code(429)
          .header('retry-after', String(retryAfter(ms)))
          .send({ error: 'too_many_attempts' });
      }
      // Uniform for every failure: a wrong password, an empty field and a
      // mis-shaped stored hash are indistinguishable from outside.
      return rep.code(401).send({ error: 'invalid_credentials' });
    }

    let epoch: string;
    try {
      await clearFailures(ip);
      epoch = await ensureOperatorSessionEpoch();
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    return { ok: true, epoch };
  });
}
