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
  bumpClientSessionEpoch,
  resolveClientSession,
} from '../lib/clientSession.js';
import { supabaseAdmin, supabaseAnon, findSupabaseUserByEmail } from '../lib/supabase.js';
import { config } from '../config.js';

/**
 * Client identity for the dashboard.
 *
 * Credentials live in Supabase Auth: passwords, email confirmation and recovery
 * are Supabase's, while this API keeps the session layer that sits on top (the
 * Redis `sid` bound to the account's session epoch, via src/lib/clientSession.ts).
 *
 * Mirrors `operatorAuth` structurally — uniform failures, escalating per-bucket
 * lockout keyed per IP *and* per account — with three ways into a session:
 *
 *   - `login`     checks email/password (scrypt for legacy accounts still holding a
 *                 local hash; Supabase `signInWithPassword` once an account has a
 *                 `supabase_uid`), then mints a session.
 *   - `exchange`  trades a Supabase session token (Google OAuth, password-reset
 *                 completion) for one of our sids, linking the auth user to the
 *                 account by `supabase_uid` (or by email, when a pre-migration
 *                 invite left the link unset).
 *   - `register`  Self-service invite path: the operator's invitation is confirmed
 *                 on Supabase's side and this API only records her row.
 *
 * On success the caller receives a session id (`sid`) bound to the account's
 * session epoch. The sid is the only thing that unlocks the account's data: the
 * web BFF stores it in the `aca_session` cookie and forwards it per request in
 * the `x-client-session` header, and `resolveClientSession` (src/lib/clientSession.ts)
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

const accessTokenBody = z.object({ accessToken: z.string().min(1).max(8192) });

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
      clientId: client.id,
      name: client.name,
      email: client.email,
      sid: session.sid,
      epoch: session.epoch,
      expiresIn: session.expiresIn,
    };
  });

  /**
   * Self-service registration. Creates the identity in Supabase (`email_confirm:
   * false`, so Supabase mails the confirmation link) and records the account row.
   * The response is uniformly successful: revealing that an email is already
   * registered would hand out a user-existence oracle.
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
        email_confirm: false,
        user_metadata: { name },
      });
      if (error) {
        if (error.code === 'user_already_exists') {
          // A registration raced an existing identity (e.g. an invited account
          // created before this email ever signed up). Reuse the identity, resend
          // the confirmation link so the invite still resolves, and link the
          // account row — the response stays uniformly successful.
          const existing = await findSupabaseUserByEmail(admin, email);
          if (existing) await linkExistingClient(email, existing.id);
          await anon.auth.resend({ type: 'signup', email });
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

  /** Uniform no-enumeration recovery: the Supabase email template owns the UX. */
  app.post('/api/auth/client/forgot', async (req, rep) => {
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
   * After a password reset the pre-reset session epoch must die: several of the
   * operator's session-killing actions key off it, and a reset is the one case
   * where the user herself rotated credentials without going through a route that
   * bumps it. The caller (web /login/reset) hits this after `verifyOtp`, then
   * `exchange` to mint the fresh session that supersedes everything the epoch
   * just invalidated.
   */
  app.post('/api/auth/client/reset-complete', async (req, rep) => {
    const { accessToken } = accessTokenBody.parse(req.body ?? {});
    const client = await resolveByAccessToken(accessToken, rep);
    if (!client) return;
    try {
      await bumpClientSessionEpoch(client.id);
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }
    return { ok: true, clientId: client.id };
  });

  /**
   * Trades a Supabase session token (Google OAuth callback, email-confirmation or
   * password-reset completion) for one of our sids. The identity is resolved by
   * `supabase_uid`; a pre-migration account that still has only a scrypt hash is
   * linked by email on first exchange, which is also the moment a legacy delegate
   * becomes fully Supabase-managed.
   */
  app.post('/api/auth/client/exchange', async (req, rep) => {
    const { accessToken } = accessTokenBody.parse(req.body ?? {});
    const client = await resolveByAccessToken(accessToken, rep);
    if (!client) return;
    if (client.status !== 'active') {
      return rep.code(401).send({ error: 'invalid_session' });
    }

    let session: { sid: string; expiresIn: number; epoch: string };
    try {
      session = await createClientSession(client.id);
    } catch {
      return rep.code(503).send({ error: 'auth_unavailable' });
    }
    return {
      ok: true,
      clientId: client.id,
      name: client.name,
      email: client.email,
      sid: session.sid,
      epoch: session.epoch,
      expiresIn: session.expiresIn,
    };
  });

  /** Revokes the sid that authenticated the request. Best-effort by design. */
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

/**
 * Resolves a Supabase session token to a client account, treating an account that
 * was invited before the migration as linkable by email. Sends a 503 on Supabase
 * outages, a 401 here for a token that verifies but reaches no account — both are
 * deliberately unrevealing, and both mean "no session".
 */
async function resolveByAccessToken(
  accessToken: string,
  rep: FastifyReply,
): Promise<{ id: string; name: string; email: string; status: string } | null> {
  const admin = supabaseAdmin();
  if (!admin) {
    rep.code(503).send({ error: 'auth_unavailable' });
    return null;
  }
  let userId: string;
  let userEmail: string | undefined;
  try {
    const { data, error } = await admin.auth.getUser(accessToken);
    if (error || !data.user) {
      rep.code(401).send({ error: 'invalid_credentials' });
      return null;
    }
    userId = data.user.id;
    userEmail = data.user.email ?? undefined;
  } catch {
    rep.code(503).send({ error: 'auth_unavailable' });
    return null;
  }
  try {
    let client = await clientRepo.getBySupabaseUid(userId);
    if (!client && userEmail) {
      const byEmail = await clientRepo.findByEmail(normalizeEmail(userEmail));
      if (byEmail) {
        await clientRepo.setSupabaseUid(byEmail.id, userId);
        client = byEmail;
      }
    }
    if (!client) {
      rep.code(401).send({ error: 'invalid_credentials' });
      return null;
    }
    return { id: client.id, name: client.name, email: client.email, status: client.status };
  } catch {
    rep.code(503).send({ error: 'auth_unavailable' });
    return null;
  }
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