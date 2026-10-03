import { FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { consumeRateLimit, reqIp } from '../lib/rateLimit.js';
import { clientRepo } from '../db/repos.js';
import {
  hashPassword,
  verifyPassword,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
} from '../lib/passwordHash.js';
import {
  clearFailures,
  lockRemainingMs,
  recordFailure,
  retryAfter,
} from '../lib/loginLockout.js';
import {
  getSid,
  revokeClientSession,
  createClientSession,
  bumpClientSessionAndKeep,
  resolveClientSession,
} from '../lib/clientSession.js';
import { supabaseAdmin, supabaseAnon, findSupabaseUserByEmail } from '../lib/supabase.js';
import { config } from '../config.js';

/**
 * Client identity for the dashboard.
 *
 * Credentials live in Supabase Auth: passwords and recovery are Supabase's, while
 * this API keeps the session layer that sits on top (the Redis `sid` bound to the
 * account's session epoch, via src/lib/clientSession.ts).
 *
 * Mirrors `operatorAuth` structurally — uniform failures, escalating per-bucket
 * lockout keyed per IP *and* per account — with three ways in:
 *
 *   - `login`     checks email/password (scrypt for legacy accounts still holding a
 *                 local hash; Supabase `signInWithPassword` once an account has a
 *                 `supabase_uid`), then mints a session.
 *   - `register`  Self-service registration: the identity is created already
 *                 confirmed, so the account is usable the moment signup returns.
 *   - `password`  Rotates the credential and re-mints this sid against a new epoch,
 *                 so she stays signed in here and nowhere else.
 *
 * Signing in *with* a Supabase token (Google OAuth, a completed reset) is not here:
 * `authExchange.ts` owns it, because that route resolves an operator and a client
 * from the same token and picking between them must not be the caller's choice.
 *
 * On success the caller receives a session id (`sid`) bound to the account's
 * session epoch. The sid is the only thing that unlocks the account's data: the
 * web BFF stores it in the `aca_session` cookie and forwards it per request in the
 * `x-client-session` header, and `resolveClientSession` (src/lib/clientSession.ts)
 * is the authoritative check on every guarded API call.
 */

const loginWindow = { limit: 20, windowSec: 60 };
const forgotWindow = { limit: 5, windowSec: 60 * 60 };

const FAIL_IP_PREFIX = 'cli:login:fail:ip:';
const LOCK_IP_PREFIX = 'cli:login:lock:ip:';
const FAIL_EMAIL_PREFIX = 'cli:login:fail:email:';
const LOCK_EMAIL_PREFIX = 'cli:login:lock:email:';

/** Accounts are keyed by this exact normalization, so every route applies it too. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const loginBody = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  newPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

const registerBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().min(1).max(320),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
});

const emailBody = z.object({ email: z.string().trim().min(1).max(320) });

/**
 * A fixed scrypt digest to burn CPU against when the email does not exist, so a
 * wrong-password response costs the same as a real verification and a caller
 * cannot time account existence. Scrypt's cost dominates, so the ~50ms this adds
 * to genuinely unknown emails is the point, not an edge case.
 */
let dummyHash = '';

async function requireClient(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const resolved = await resolveClientSession(req, reply);
  if (!resolved) return;
  (req as any).client = resolved;
}

export async function clientAuth(app: FastifyInstance) {
  // Precompute lazily so a service that never handles a client login pays nothing.
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-placeholder');

  app.post('/api/auth/client/login', async (req, rep) => {
    const parsed = loginBody.safeParse(req.body ?? {});
    if (!parsed.success) return rep.code(400).send({ error: 'validation_error', issues: parsed.error.issues });

    const email = normalizeEmail(parsed.data.email);
    const { password } = parsed.data;
    const ip = reqIp(req);

    // Backstop rate limit, then the two escalating buckets.
    try {
      await consumeRateLimit(`ip:client-login:${ip}`, loginWindow);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 429) throw err;
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    let lock = 0;
    try {
      lock = Math.max(await lockRemainingMs(`${LOCK_IP_PREFIX}${ip}`), await lockRemainingMs(`${LOCK_EMAIL_PREFIX}${email}`));
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }
    if (lock > 0) {
      return rep.code(429).header('retry-after', String(retryAfter(lock))).send({ error: 'too_many_attempts' });
    }

    let client: {
      id: string;
      name: string;
      email: string;
      status: string;
      passwordHash: string | null;
      supabaseUid: string | null;
    } | null = null;
    try {
      const row = await clientRepo.findByEmail(email);
      client = row
        ? { id: row.id, name: row.name, email: row.email, status: row.status, passwordHash: row.passwordHash, supabaseUid: row.supabaseUid }
        : null;
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    let ok = false;
    if (!client) {
      // Unknown email: burn the same CPU a real verification would (see dummyHash).
      ok = await verifyPassword(password, dummyHash);
    } else if (client.passwordHash) {
      // Legacy scrypt account that hasn't been imported to Supabase yet.
      ok = await verifyPassword(password, client.passwordHash);
    } else {
      // Supabase-managed identity. The confirmation gate doubles as the "bad
      // credential" bucket: an unconfirmed signup fails exactly like a wrong
      // password so a caller cannot tell them apart.
      const anon = supabaseAnon();
      if (!anon) return rep.code(503).send({ error: 'auth_unavailable' });
      try {
        const { data, error } = await anon.auth.signInWithPassword({ email, password });
        if (error) {
          ok = false;
        } else if (!data.user.email_confirmed_at) {
          ok = false;
        } else if (client.supabaseUid && data.user.id !== client.supabaseUid) {
          // The row and the auth identity disagree; treat as a bad credential.
          ok = false;
        } else {
          ok = true;
        }
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
    }

    if (!ok || !client || client.status !== 'active') {
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
      // Uniform for every failure: bad email, wrong password, unconfirmed signup,
      // suspended account.
      return rep.code(401).send({ error: 'invalid_credentials' });
    }

    let session: { sid: string; expiresIn: number; epoch: string };
    try {
      await clearFailures(`${FAIL_IP_PREFIX}${ip}`, `${LOCK_IP_PREFIX}${ip}`);
      await clearFailures(`${FAIL_EMAIL_PREFIX}${email}`, `${LOCK_EMAIL_PREFIX}${email}`);
      session = await createClientSession(client.id);
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    return {
      ok: true,
      // Stated rather than left to the caller to assume: the BFF writes a different
      // cookie per kind, and a response missing the field that tells them apart must
      // fail closed rather than be inferred.
      kind: 'client' as const,
      clientId: client.id,
      name: client.name,
      email: client.email,
      sid: session.sid,
      epoch: session.epoch,
      expiresIn: session.expiresIn,
    };
  });

  /**
   * Self-service registration. Creates the identity in Supabase already confirmed
   * (`email_confirm: true`) and records the account row, so a new account is accepted
   * immediately — no confirmation link to wait on before the first sign-in. The
   * response is uniformly successful: revealing that an email is already registered
   * would hand out a user-existence oracle.
   */
  app.post('/api/auth/client/register', async (req, rep) => {
    const parsed = registerBody.safeParse(req.body ?? {});
    if (!parsed.success) return rep.code(400).send({ error: 'validation_error', issues: parsed.error.issues });

    const email = normalizeEmail(parsed.data.email);
    if (!email.includes('@')) {
      return rep.code(400).send({ error: 'validation_error', issues: [{ message: 'valid email required' }] });
    }
    const { name, password } = parsed.data;

    try {
      await consumeRateLimit(`ip:client-register:${reqIp(req)}`, loginWindow);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 429) throw err;
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    const admin = supabaseAdmin();
    const anon = supabaseAnon();
    if (!admin || !anon) return rep.code(503).send({ error: 'auth_unavailable' });

    let uid: string;
    try {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name },
      });
      if (error) {
        if (error.code === 'user_already_exists') {
          // A registration raced an existing identity (e.g. an invited account
          // created before this email ever signed up). Reuse it, confirm it so the
          // account is immediately usable too, and link the account row — the
          // response stays uniformly successful.
          const existing = await findSupabaseUserByEmail(admin, email);
          if (existing) {
            await admin.auth.admin.updateUserById(existing.id, { email_confirm: true }).catch(() => {});
            await linkExistingClient(email, existing.id);
          }
          return rep.code(200).send({ ok: true });
        }
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      uid = data.user.id;
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    try {
      await clientRepo.create({ name, email, passwordHash: null, supabaseUid: uid });
    } catch {
      // The operator invited the same email between the unique check and here:
      // link the row rather than orphan the Supabase identity.
      await linkExistingClient(email, uid);
    }
    return rep.code(200).send({ ok: true });
  });

  /**
   * Starts password recovery. Uniform no-enumeration: the Supabase email template
   * owns the UX, and the answer is the same whether or not the address is registered.
   *
   * Kind-neutral by design, and registered without the `/client` prefix it used to
   * carry. It never touches a local row — it hands an address to Supabase and lets the
   * provider decide — so an operator with a forgotten password uses this same route,
   * and a path named for merchants would be a small lie about who it serves. The
   * callback it points at is the BFF's `/login/reset`, which finishes through the
   * unified `/api/auth/exchange`, so the same link works for either principal.
   */
  app.post('/api/auth/forgot', async (req, rep) => {
    const parsed = emailBody.safeParse(req.body ?? {});
    if (!parsed.success) return rep.code(400).send({ error: 'validation_error', issues: parsed.error.issues });
    const email = normalizeEmail(parsed.data.email);

    try {
      await consumeRateLimit(`ip:client-forgot:${reqIp(req)}`, loginWindow);
      await consumeRateLimit(`email:client-forgot:${email}`, forgotWindow);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 429) throw err;
      return rep.code(503).send({ error: 'auth_unavailable' });
    }

    const anon = supabaseAnon();
    if (!anon) return rep.code(503).send({ error: 'auth_unavailable' });
    try {
      const redirectTo = new URL('login/reset', config.APP_BASE_URL).toString();
      await anon.auth.resetPasswordForEmail(email, { redirectTo });
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }
    return rep.code(200).send({ ok: true });
  });

  /**
   * Revokes the sid that authenticated the request. Best-effort by design.
   *
   * The dashboard calls the unified `/api/auth/logout` instead, which handles either
   * principal; this stays because it is the narrower statement of intent for a client
   * session and costs one route.
   */
  app.post(
    '/api/auth/client/logout',
    { preHandler: [requireClient] },
    async (req) => {
      const sid = getSid(req);
      if (sid) await revokeClientSession(sid);
      return { ok: true };
    },
  );

  /**
   * Changes the account password, then rotates the epoch AND re-mints the caller's
   * sid against it: the person editing their password stays signed in while every
   * other device is logged out. The returned epoch is what the web BFF re-signs
   * into the cookie.
   */
  app.post(
    '/api/auth/client/password',
    { preHandler: [requireClient] },
    async (req, rep) => {
      const { currentPassword, newPassword } = passwordBody.parse(req.body);

      if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword === currentPassword) {
        return rep.code(400).send({ error: 'validation_error', issues: [{ message: 'password_requirements' }] });
      }

      const client = (req as any).client as { clientId: string };
      let row: Awaited<ReturnType<typeof clientRepo.get>> = null;
      try {
        row = await clientRepo.get(client.clientId);
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      const stored = row?.passwordHash ?? null;

      if (!stored) {
        // Supabase-managed identity: verify the current password against Auth,
        // then rotate it there. No local hash is ever written.
        const anon = supabaseAnon();
        const admin = supabaseAdmin();
        if (!anon || !admin) return rep.code(503).send({ error: 'auth_unavailable' });
        if (!row?.supabaseUid) return rep.code(401).send({ error: 'invalid_credentials' });
        try {
          const { error } = await anon.auth.signInWithPassword({ email: row.email, password: currentPassword });
          if (error) return rep.code(401).send({ error: 'invalid_credentials' });
        } catch {
          return rep.code(503).send({ error: 'auth_unavailable' });
        }
        let epoch = '';
        try {
          const { error } = await admin.auth.admin.updateUserById(row.supabaseUid, { password: newPassword });
          if (error) return rep.code(503).send({ error: 'auth_unavailable' });
          epoch = await bumpClientSessionAndKeep(getSid(req) ?? '', client.clientId);
        } catch {
          return rep.code(503).send({ error: 'auth_unavailable' });
        }
        return { ok: true, epoch };
      }

      const ok = await verifyPassword(currentPassword, stored);
      if (!ok) return rep.code(401).send({ error: 'invalid_credentials' });

      let nextHash = '';
      let epoch = '';
      try {
        nextHash = await hashPassword(newPassword);
        await clientRepo.setPassword(client.clientId, nextHash);
        epoch = await bumpClientSessionAndKeep(getSid(req) ?? '', client.clientId);
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      return { ok: true, epoch };
    },
  );

  app.get(
    '/api/auth/client/me',
    { preHandler: [requireClient] },
    async (req) => {
      const client = (req as any).client as { clientId: string; name: string; email: string };
      return { client };
    },
  );
}

/** Links a Supabase auth user to an existing account row; no-op when it misses. */
async function linkExistingClient(email: string, uid: string): Promise<void> {
  try {
    const row = await clientRepo.findByEmail(email);
    if (row && !row.supabaseUid) await clientRepo.setSupabaseUid(row.id, uid);
  } catch {
    // Best effort: the register response is already successful.
  }
}