import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consumeRateLimit, reqIp } from '../lib/rateLimit.js';
import { MAX_PASSWORD_LENGTH, verifyPassword } from '../lib/passwordHash.js';
import {
  clearFailures,
  lockRemainingMs,
  recordFailure,
  retryAfter,
} from '../lib/loginLockout.js';
import { createOperatorSession } from '../lib/operatorSession.js';
import { createClientSession } from '../lib/clientSession.js';
import { clientRepo } from '../db/repos.js';
import { resolveSupabaseIdentity } from '../lib/localIdentity.js';
import { supabaseAnon } from '../lib/supabase.js';

/**
 * The single sign-in route.
 *
 * There used to be two forms posting to `/api/auth/operator/login` and
 * `/api/auth/client/login`, and the person had to know which they were before they
 * typed. The credential was never different — both email and password against Supabase
 * — so the tabs only chose an endpoint. This route asks once and resolves the kind
 * *after* the credential is proved, exactly as `/api/auth/exchange` already does for
 * OAuth: one lookup decides, the caller does not.
 *
 * Auto-detection is not a weakening. The operator/client refusal is still the shared
 * {@link resolveSupabaseIdentity} rule (an identity linked on both sides is rejected),
 * and a suspended account is refused the same as an unknown one. What changes is only
 * that the endpoint no longer trusts a caller-supplied `kind`.
 *
 * The escalation and lockout use their own per-IP/per-email buckets, so this route
 * cannot be used to skip the two legacy routes' counters (and vice versa).
 */

const loginWindow = { limit: 20, windowSec: 60 };

const FAIL_IP_PREFIX = 'login:fail:ip:';
const LOCK_IP_PREFIX = 'login:lock:ip:';
const FAIL_EMAIL_PREFIX = 'login:fail:email:';
const LOCK_EMAIL_PREFIX = 'login:lock:email:';

const loginBody = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export async function login(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, rep) => {
    const parsed = loginBody.safeParse(req.body ?? {});
    if (!parsed.success) return rep.code(400).send({ error: 'validation_error', issues: parsed.error.issues });

    const email = parsed.data.email.trim().toLowerCase();
    const { password } = parsed.data;
    const ip = reqIp(req);

    // Backstop rate limit, then the escalating per-IP and per-account buckets. An
    // operator password is as guessable as a merchant one, so both share the shape.
    try {
      await consumeRateLimit(`ip:login:${ip}`, loginWindow);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 429) throw err;
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    let lock = 0;
    try {
      lock = Math.max(
        await lockRemainingMs(`${LOCK_IP_PREFIX}${ip}`),
        await lockRemainingMs(`${LOCK_EMAIL_PREFIX}${email}`),
      );
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }
    if (lock > 0) {
      return rep.code(429).header('retry-after', String(retryAfter(lock))).send({ error: 'too_many_attempts' });
    }

    // The local rows are read up front only to find a legacy scrypt account, which has
    // no Supabase identity to verify against. This is not an existence oracle: the
    // response is identical whichever rows exist.
    let clientByEmail: Awaited<ReturnType<typeof clientRepo.findByEmail>> = null;
    try {
      clientByEmail = await clientRepo.findByEmail(email);
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    type Identity =
      | { kind: 'operator'; id: string; name: string; email: string }
      | { kind: 'client'; id: string; name: string; email: string };
    let identity: Identity | null = null;

    const legacyClient =
      clientByEmail && clientByEmail.passwordHash && !clientByEmail.supabaseUid ? clientByEmail : null;

    if (legacyClient) {
      // A merchant imported before Supabase managed their credential. Verified locally,
      // exactly as `clientAuth` did; no provider call is made.
      let ok = false;
      try {
        ok = await verifyPassword(password, legacyClient.passwordHash!);
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      if (ok && legacyClient.status === 'active') {
        identity = { kind: 'client', id: legacyClient.id, name: legacyClient.name, email: legacyClient.email };
      }
    } else {
      const anon = supabaseAnon();
      if (!anon) return rep.code(503).send({ error: 'auth_unavailable' });

      // The confirmation gate doubles as the bad-credential bucket: an unconfirmed
      // signup fails exactly like a wrong password so the two cannot be told apart.
      let userId: string | null = null;
      try {
        const { data, error } = await anon.auth.signInWithPassword({ email, password });
        if (!error && data.user && data.user.email_confirmed_at) userId = data.user.id;
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }

      if (userId) {
        try {
          const resolution = await resolveSupabaseIdentity({
            userId,
            email,
            linkOperatorByEmail: true,
            autoProvision: false,
          });
          if (resolution.status === 'conflict') {
            req.log.error(
              { supabaseUserId: userId, operatorId: resolution.operatorId, clientId: resolution.clientId },
              'supabase identity linked to both an operator and a client; refusing to sign in',
            );
          } else if (resolution.status === 'ok') {
            identity = resolution.identity;
          }
        } catch {
          return rep.code(503).send({ error: 'auth_unavailable' });
        }
      }
    }

    if (!identity) {
      try {
        const msIp = await recordFailure(`${FAIL_IP_PREFIX}${ip}`, `${LOCK_IP_PREFIX}${ip}`);
        const msEmail = await recordFailure(`${FAIL_EMAIL_PREFIX}${email}`, `${LOCK_EMAIL_PREFIX}${email}`);
        if (msIp > 0 || msEmail > 0) {
          return rep
            .code(429)
            .header('retry-after', String(retryAfter(Math.max(msIp, msEmail))))
            .send({ error: 'too_many_attempts' });
        }
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      // Uniform for every failure: unknown email, wrong password, unconfirmed signup,
      // suspended account, or an identity that resolved to nothing.
      return rep.code(401).send({ error: 'invalid_credentials' });
    }

    try {
      await clearFailures(`${FAIL_IP_PREFIX}${ip}`, `${LOCK_IP_PREFIX}${ip}`);
      await clearFailures(`${FAIL_EMAIL_PREFIX}${email}`, `${LOCK_EMAIL_PREFIX}${email}`);
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    if (identity.kind === 'operator') {
      let session: { sid: string; expiresIn: number; epoch: string; globalEpoch: string };
      try {
        session = await createOperatorSession(identity.id);
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      return {
        ok: true,
        // Stated, not inferred: the BFF writes a different cookie per kind and must not
        // take the request's word for which.
        kind: 'operator' as const,
        operatorId: identity.id,
        name: identity.name,
        email: identity.email,
        sid: session.sid,
        epoch: session.epoch,
        globalEpoch: session.globalEpoch,
        expiresIn: session.expiresIn,
      };
    }

    let session: { sid: string; expiresIn: number; epoch: string };
    try {
      session = await createClientSession(identity.id);
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }
    return {
      ok: true,
      kind: 'client' as const,
      clientId: identity.id,
      name: identity.name,
      email: identity.email,
      sid: session.sid,
      epoch: session.epoch,
      expiresIn: session.expiresIn,
    };
  });
}
