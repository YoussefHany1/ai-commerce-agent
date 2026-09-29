import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { consumeRateLimit, reqIp } from '../lib/rateLimit.js';
import { verifyOperatorPassword, MAX_OPERATOR_PASSWORD_LENGTH } from '../lib/passwordHash.js';
import { ensureOperatorSessionEpoch } from '../lib/operatorSession.js';
import {
  clearFailures,
  lockRemainingMs,
  recordFailure,
  retryAfter,
} from '../lib/loginLockout.js';

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

const FAIL_PREFIX = 'op:login:fail:';
const LOCK_PREFIX = 'op:login:lock:';

const body = z.object({ password: z.string().min(1).max(MAX_OPERATOR_PASSWORD_LENGTH) });

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
      locked = await lockRemainingMs(`${LOCK_PREFIX}${ip}`);
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
        ms = await recordFailure(`${FAIL_PREFIX}${ip}`, `${LOCK_PREFIX}${ip}`);
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
      await clearFailures(`${FAIL_PREFIX}${ip}`, `${LOCK_PREFIX}${ip}`);
      epoch = await ensureOperatorSessionEpoch();
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    return { ok: true, epoch };
  });
}
