import { FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { consumeRateLimit, reqIp } from '../lib/rateLimit.js';
import { MAX_PASSWORD_LENGTH } from '../lib/passwordHash.js';
import {
  clearFailures,
  lockRemainingMs,
  recordFailure,
  retryAfter,
} from '../lib/loginLockout.js';
import {
  createOperatorSession,
  getSid,
  resolveOperatorSession,
  revokeOperatorSession,
} from '../lib/operatorSession.js';
import { clientRepo, operatorRepo } from '../db/repos.js';
import { supabaseAnon } from '../lib/supabase.js';
import { normalizeEmail } from './clientAuth.js';

/**
 * Operator identity for the dashboard.
 *
 * An operator is a person, and this is where that person proves it. There is no
 * password in this process any more: `POST /api/auth/operator/verify` — a route
 * that took a bare password and answered `{ok}`, with no username and therefore no
 * identity — is gone, along with `OPERATOR_PASSWORD_HASH`. Credentials are Supabase
 * Auth's, exactly as they already were for client accounts; what this service owns
 * is the session layer above them (the Redis `sid` bound to the operator's epoch and
 * to the install-wide epoch), and the `operators` row that says whether this
 * particular person is currently allowed in.
 *
 * The structural mirror of `clientAuth` is deliberate — same uniform-failure
 * discipline, same escalating lockout keyed per IP *and* per account — because the
 * two principals must not differ in how hard they are to guess at. Three ways into
 * a session, of which two are shared with clients:
 *
 *   - `login`    email + password against Supabase, then mint a session. Used when
 *                the account has a password at all; a Google-only operator never
 *                reaches it.
 *   - `exchange` a Supabase session token, resolved to an operator by
 *                `supabase_uid` (or by email, for an invite whose link is unset).
 *                Lives in `authExchange.ts` because clients and operators share it.
 *   - `logout`   revokes this sid only, so signing out of one device leaves the
 *                others alone.
 *
 * On success the caller receives a `sid` bound to the operator's per-person epoch and
 * to the install-wide epoch. The web BFF puts both in the `aca_session` cookie and
 * forwards the sid in `x-operator-session`; `resolveOperatorSession`
 * (src/lib/operatorSession.ts) is the authoritative check on every guarded call.
 */

const loginWindow = { limit: 20, windowSec: 60 };

const FAIL_IP_PREFIX = 'op:login:fail:ip:';
const LOCK_IP_PREFIX = 'op:login:lock:ip:';
const FAIL_EMAIL_PREFIX = 'op:login:fail:email:';
const LOCK_EMAIL_PREFIX = 'op:login:lock:email:';

const loginBody = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

async function requireOperatorSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const resolved = await resolveOperatorSession(req, reply);
  if (!resolved) return;
  (req as any).operator = resolved;
}

export async function operatorAuth(app: FastifyInstance) {
  /**
   * Email + password sign-in, verified by Supabase.
   *
   * Note what this route does *not* do: it does not decide whether the email belongs
   * to an operator before asking Supabase. A pre-flight lookup would be an existence
   * oracle — the response time and body would say whether an address has an admin
   * account, which is a far more useful thing to learn than whether one exists at
   * all. Instead the credential check and the account lookup both happen, and every
   * failure — unknown email, wrong password, unconfirmed signup, no operator row,
   * suspended operator — collapses to one indistinguishable 401.
   */
  app.post('/api/auth/operator/login', async (req, rep) => {
    const parsed = loginBody.safeParse(req.body ?? {});
    if (!parsed.success) return rep.code(400).send({ error: 'validation_error', issues: parsed.error.issues });

    const anon = supabaseAnon();
    if (!anon) return rep.code(503).send({ error: 'auth_unavailable' });

    const email = normalizeEmail(parsed.data.email);
    const { password } = parsed.data;
    const ip = reqIp(req);

    // Backstop rate limit, then the two escalating buckets. Same shape as the client
    // login: an operator password is as guessable as a client one, and an operator is
    // worth far more to an attacker.
    try {
      await consumeRateLimit(`ip:operator-login:${ip}`, loginWindow);
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

    // Supabase first: an unconfirmed signup must fail exactly like a wrong password,
    // so the confirmation gate doubles as the bad-credential bucket.
    let userId: string | null = null;
    try {
      const { data, error } = await anon.auth.signInWithPassword({ email, password });
      if (error || !data.user || !data.user.email_confirmed_at) userId = null;
      else userId = data.user.id;
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    let operator: { id: string; name: string; email: string; status: string; supabaseUid: string | null } | null = null;
    if (userId) {
      try {
        // The client side is asked about too, and the pair is a refusal rather than a
        // preference. The two `supabase_uid` unique indexes are per-table, so a Supabase
        // user linked on both sides is representable in the schema; where that has
        // happened, signing in here would hand the operator surface to whoever holds
        // the shared identity. Refuse and let an operator sort the rows out.
        const [byUid, clientByUid] = await Promise.all([
          operatorRepo.getBySupabaseUid(userId),
          clientRepo.getBySupabaseUid(userId),
        ]);
        if (byUid && clientByUid) {
          req.log.error(
            { supabaseUserId: userId, operatorId: byUid.id, clientId: clientByUid.id },
            'supabase identity linked to both an operator and a client; refusing to sign in',
          );
          return rep.code(401).send({ error: 'invalid_credentials' });
        }
        if (byUid) operator = byUid;
        else {
          // An invite written before the identity was linked: bind them now, and only
          // on a credential that just proved the address.
          const byEmail = await operatorRepo.findByEmail(email);
          // A client row holding the same address is the same split seen from the other
          // side; binding would make this identity both, so leave it to an operator.
          const clientByEmail = await clientRepo.findByEmail(email);
          if (byEmail && !clientByEmail) {
            await operatorRepo.setSupabaseUid(byEmail.id, userId);
            operator = byEmail;
          }
        }
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
    }

    if (!userId || !operator || operator.status !== 'active') {
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
      return rep.code(401).send({ error: 'invalid_credentials' });
    }

    let session: { sid: string; expiresIn: number; epoch: string; globalEpoch: string };
    try {
      await clearFailures(`${FAIL_IP_PREFIX}${ip}`, `${LOCK_IP_PREFIX}${ip}`);
      await clearFailures(`${FAIL_EMAIL_PREFIX}${email}`, `${LOCK_EMAIL_PREFIX}${email}`);
      session = await createOperatorSession(operator.id);
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    return {
      ok: true,
      // Stated rather than left to the caller to assume: the BFF writes a different
      // cookie per kind, and it may not take the request's word for which to write.
      kind: 'operator' as const,
      operatorId: operator.id,
      name: operator.name,
      email: operator.email,
      sid: session.sid,
      epoch: session.epoch,
      globalEpoch: session.globalEpoch,
      expiresIn: session.expiresIn,
    };
  });

  /**
   * Revokes the sid that authenticated the request — this browser only. The install
   * has `npm run revoke-operator-sessions` for everyone, and the per-operator epoch
   * for a whole person.
   */
  app.post(
    '/api/auth/operator/logout',
    { preHandler: [requireOperatorSession] },
    async (req) => {
      const sid = getSid(req);
      if (sid) await revokeOperatorSession(sid);
      return { ok: true };
    },
  );

  /** Who am I, as far as this API is concerned. The dashboard shell asks for this. */
  app.get(
    '/api/auth/operator/me',
    { preHandler: [requireOperatorSession] },
    async (req) => {
      const operator = (req as any).operator as { operatorId: string; email: string; name: string };
      return { operator };
    },
  );
}
