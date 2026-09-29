import { FastifyInstance } from 'fastify';
import type { FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { clientRepo, storeRepo, clientToPublic, storeToPublic } from '../db/repos.js';
import { hashPassword, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../lib/passwordHash.js';
import { bumpClientSessionEpoch } from '../lib/clientSession.js';
import { requireOperator } from '../lib/auth.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { config } from '../config.js';
import { supabaseAdmin, findSupabaseUserByEmail } from '../lib/supabase.js';
import { normalizeEmail } from './clientAuth.js';

/**
 * Operator-only account management. Clients are invite-only by design: accounts
 * exist only because this surface (or the `client:create` script) created them.
 * Everything here is admin work — the attacker on the other end of the invite is
 * the person you just handed a login to, so actions that must kill their sessions
 * (suspend, password reset) bump the account's epoch too.
 *
 * Since the credentials moved to Supabase Auth, "creating an account" is two
 * writes that must stay in step: a Supabase auth user (`email_confirm: true`, so
 * the one-time password is usable immediately) and the local account row, linked
 * by `supabase_uid`. A legacy account that still holds a local scrypt hash keeps
 * authenticating through it until the import script promotes it.
 */

const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };

const idParam = z.object({ id: z.string().uuid() });
const statusBody = z.object({ status: z.enum(['active', 'suspended']) });
const passwordBody = z.object({ password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH) });
const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(320),
  password: passwordBody.shape.password.optional(),
});
const assignBody = z.object({ storeId: z.string().uuid() });
const assignParam = z.object({ id: z.string().uuid(), storeId: z.string().uuid() });

export async function clients(app: FastifyInstance) {
  app.get('/api/clients', { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] }, async () => {
    const rows = await clientRepo.list();
    const counts = await clientRepo.storeCountsFor(rows.map((r) => r.id));
    return rows.map((c) => ({ ...clientToPublic(c), storeCount: counts.get(c.id) ?? 0 }));
  });

  app.post(
    '/api/clients',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const body = createBody.parse(req.body);
      const email = normalizeEmail(body.email);
      if (!email.includes('@')) return rep.code(400).send({ error: 'validation_error', issues: [{ message: 'valid email required' }] });
      if (await clientRepo.findByEmail(email)) {
        return rep.code(409).send({ error: 'client_already_exists' });
      }
      const admin = supabaseAdmin();
      if (!admin) return rep.code(503).send({ error: 'auth_unavailable' });

      const temporary = body.password ?? randomBytes(10).toString('hex').slice(0, 16);
      const uid = await ensureSupabaseUser(admin, email, temporary, rep);
      if (!uid) return;

      // Inserted with a NULL hash: the only credential that exists is the one
      // Supabase holds, so nothing to hash (or to leak) here.
      const id = await clientRepo.create({ name: body.name, email, passwordHash: null, supabaseUid: uid });
      const client = await clientRepo.get(id);
      if (!client) throw Object.assign(new Error('client_creation_failed'), { statusCode: 500 });
      // The temporary password is only correct once, and only ever appears here:
      // the invite holder can replace it via POST /api/auth/client/password (which
      // revokes every other device) or the email recovery link.
      return rep.code(201).send({ ...clientToPublic(client), temporaryPassword: body.password ? undefined : temporary });
    },
  );

  app.get(
    '/api/clients/:id',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { id } = idParam.parse(req.params);
      const client = await clientRepo.get(id);
      if (!client) return rep.code(404).send({ error: 'client_not_found' });
      const stores = await storeRepo.listForClient(id);
      return { client: clientToPublic(client), stores: stores.map(storeToPublic) };
    },
  );

  /**
   * Suspending an account must log it out everywhere it is signed in, not just
   * block the next login — otherwise a window full of live sessions keeps acting
   * until logout. Reactivating clears the status and lets login resume; stale
   * sessions are already dead because the epoch moved.
   */
  app.patch(
    '/api/clients/:id/status',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { id } = idParam.parse(req.params);
      const { status } = statusBody.parse(req.body);
      const done = await clientRepo.setStatus(id, status);
      if (!done) return rep.code(404).send({ error: 'client_not_found' });
      if (status === 'suspended') {
        try {
          await bumpClientSessionEpoch(id);
        } catch {
          // boundary already flipped; a failed epoch bump is surfaced as a 503 below
        }
      }
      return { ok: true, status };
    },
  );

  app.post(
    '/api/clients/:id/reset-password',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { id } = idParam.parse(req.params);
      const { password } = passwordBody.parse(req.body);
      const client = await clientRepo.get(id);
      if (!client) return rep.code(404).send({ error: 'client_not_found' });

      if (client.supabaseUid) {
        const admin = supabaseAdmin();
        if (!admin) return rep.code(503).send({ error: 'auth_unavailable' });
        try {
          const { error } = await admin.auth.admin.updateUserById(client.supabaseUid, { password });
          if (error) return rep.code(503).send({ error: 'auth_unavailable' });
        } catch {
          return rep.code(503).send({ error: 'auth_unavailable' });
        }
      } else {
        // Legacy scrypt account; Supabase has no identity for it yet.
        if (!(await clientRepo.setPassword(id, await hashPassword(password)))) {
          return rep.code(404).send({ error: 'client_not_found' });
        }
      }

      try {
        await bumpClientSessionEpoch(id);
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      return { ok: true };
    },
  );

  app.post(
    '/api/clients/:id/stores',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { id } = idParam.parse(req.params);
      const { storeId } = assignBody.parse(req.body);
      if (!(await clientRepo.get(id))) return rep.code(404).send({ error: 'client_not_found' });
      if (!(await storeRepo.get(storeId))) return rep.code(404).send({ error: 'store_not_found' });
      await storeRepo.assignClient(storeId, id);
      return { ok: true };
    },
  );

  app.delete(
    '/api/clients/:id/stores/:storeId',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { id, storeId } = assignParam.parse(req.params);
      // Only detach from the account named in the URL: a store keyed to client B
      // must not be detached by a misspelt/:id call aimed at client A.
      if (!(await storeRepo.belongsToClient(storeId, id))) {
        return rep.code(400).send({ error: 'store_not_assigned' });
      }
      await storeRepo.assignClient(storeId, null);
      return { ok: true };
    },
  );
}

/**
 * Creates the Supabase auth user for an invite (`email_confirm: true`, so the
 * operator-issued temporary password works immediately), reusing an identity that
 * already exists under the email. Returns the auth user id, or null after sending
 * a 503 — the route must `return` bare in that case.
 */
async function ensureSupabaseUser(
  admin: NonNullable<ReturnType<typeof supabaseAdmin>>,
  email: string,
  password: string,
  rep: FastifyReply,
): Promise<string | null> {
  try {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) {
      if (error.code === 'user_already_exists') {
        const existing = await findSupabaseUserByEmail(admin, email);
        if (!existing) {
          rep.code(503).send({ error: 'auth_unavailable' });
          return null;
        }
        return existing.id;
      }
      rep.code(503).send({ error: 'auth_unavailable' });
      return null;
    }
    return data.user.id;
  } catch {
    rep.code(503).send({ error: 'auth_unavailable' });
    return null;
  }
}