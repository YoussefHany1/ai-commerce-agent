import { FastifyInstance } from 'fastify';
import type { FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { operatorRepo, clientRepo, operatorToPublic } from '../db/repos.js';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../lib/passwordHash.js';
import { bumpOperatorEpoch, bumpOperatorSessionEpoch } from '../lib/operatorSession.js';
import { requireOperator, isMachineOperator } from '../lib/auth.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { config } from '../config.js';
import { supabaseAdmin, findSupabaseUserByEmail } from '../lib/supabase.js';
import { normalizeEmail } from './clientAuth.js';

/**
 * Operator management — the directory of people who run this install.
 *
 * This surface exists because operators used to be a role rather than a person. When
 * authentication was a single shared password, there was nothing to list, nothing to
 * suspend, and no way to tell who had acted: one credential, no name attached. Now that
 * a sign-in resolves to a row here, admin work has the three things it was missing —
 * an inventory, a per-person switch, and an identity to write into an audit line.
 *
 * Three deliberate asymmetries against `clients.ts`:
 *
 *   - No delete. Suspension is reversible and the row stays as the record of who was
 *     ever given this access. Deleting the person would erase exactly the evidence an
 *     incident review wants.
 *   - Nobody may suspend themselves, and the last active operator cannot be suspended
 *     at all. With a shared password the equivalent mistake was a bad deploy; with a
 *     directory it is one click, and the consequence is an install nobody can sign into.
 *   - The global epoch exists, so `POST /api/operators/revoke-all` is the answer to a
 *     suspected compromise: one call, every operator out, no per-row sweep.
 *
 * Every write here is a Supabase Auth write as much as a database write, and the two
 * are not transactional. Ordering is chosen so a partial failure is inert: the auth
 * user is created first — a Supabase user with no local row can sign in to nothing —
 * and if the local row then fails, the identity we created is removed again. Reusing
 * an identity that already existed is *not* undone on failure: it belonged to whoever
 * had it before, and the next invite for that address will find it and link it.
 */

const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };

const idParam = z.object({ id: z.string().uuid() });
const statusBody = z.object({ status: z.enum(['active', 'suspended']) });
const passwordBody = z.object({ password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH) });
const fromSupabaseBody = z.object({ uid: z.string().uuid() });
/** Cap on `listUsers` pages when building the admin-picker directory. */
const DIRECTORY_PAGE_CAP = 20;
const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().max(320),
  /** Omit to generate one; the generated value is returned once and never stored. */
  password: passwordBody.shape.password.optional(),
});

export async function operators(app: FastifyInstance) {
  app.get('/api/operators', { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] }, async () => {
    const rows = await operatorRepo.list();
    return rows.map(operatorToPublic);
  });

  /**
   * The Supabase directory, joined to the local admin grants, for the "choose admins
   * from Supabase" page. Every auth user is listed — this is the pool the operator picks
   * from — annotated with whether it currently administers the install.
   *
   * Orphan grants (an operator row whose identity is missing or no longer in Supabase)
   * are appended too, keyed by their operator id, so a grant can always be revoked even
   * when its identity has gone away. Without them a stale admin would be invisible and
   * therefore unremovable from the one surface built to remove admins.
   *
   * A Supabase user reaches no data here beyond what the Admin API exposes to a service
   * role; the route itself is operator-guarded like the rest of this surface.
   */
  app.get(
    '/api/operators/supabase-users',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (_req, rep) => {
      const admin = supabaseAdmin();
      if (!admin) return rep.code(503).send({ error: 'auth_unavailable' });

      let grants: Awaited<ReturnType<typeof operatorRepo.list>>;
      try {
        grants = await operatorRepo.list();
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      const byUid = new Map(grants.filter((g) => g.supabaseUid).map((g) => [g.supabaseUid as string, g]));

      const users: Array<{
        uid: string | null;
        email: string | null;
        name: string | null;
        createdAt: string | null;
        lastSignInAt: string | null;
        isAdmin: boolean;
        operatorId: string | null;
        status: string | null;
      }> = [];
      const seen = new Set<string>();

      try {
        for (let page = 1; page <= DIRECTORY_PAGE_CAP; page++) {
          const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
          if (error) return rep.code(503).send({ error: 'auth_unavailable' });
          const batch = data?.users ?? [];
          for (const u of batch) {
            if (!u.id) continue;
            seen.add(u.id);
            const grant = byUid.get(u.id);
            users.push({
              uid: u.id,
              email: u.email ?? null,
              name: (u.user_metadata?.name as string) || (u.user_metadata?.full_name as string) || null,
              createdAt: u.created_at ?? null,
              lastSignInAt: u.last_sign_in_at ?? null,
              isAdmin: !!grant,
              operatorId: grant?.id ?? null,
              status: grant?.status ?? null,
            });
          }
          if (batch.length < 1000) break;
        }
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }

      for (const grant of grants) {
        if (grant.supabaseUid && seen.has(grant.supabaseUid)) continue;
        users.push({
          uid: grant.supabaseUid,
          email: grant.email,
          name: grant.name,
          createdAt: grant.createdAt instanceof Date ? grant.createdAt.toISOString() : null,
          lastSignInAt: null,
          isAdmin: true,
          operatorId: grant.id,
          status: grant.status,
        });
      }

      return { users };
    },
  );

  /**
   * Invites an operator. Mirrors the client invite: a Supabase auth user
   * (`email_confirm: true`, so the temporary password works immediately) plus the local
   * row, linked by `supabase_uid`. There is no local password column and no scrypt hash
   * on this table — the identity provider is the only place a credential exists.
   */
  app.post(
    '/api/operators',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const body = createBody.parse(req.body);
      const email = normalizeEmail(body.email);
      if (!email.includes('@')) {
        return rep.code(400).send({ error: 'validation_error', issues: [{ message: 'valid email required' }] });
      }
      // One identity, one person: an address that already administers this install, or
      // that is already a merchant, cannot be invited as an operator as well. Both
      // would otherwise let a Supabase uid resolve to whichever table is asked first.
      if (await operatorRepo.findByEmail(email)) {
        return rep.code(409).send({ error: 'operator_already_exists' });
      }
      if (await clientRepo.findByEmail(email)) {
        return rep.code(409).send({ error: 'email_in_use_by_client' });
      }

      const admin = supabaseAdmin();
      if (!admin) return rep.code(503).send({ error: 'auth_unavailable' });

      const temporary = body.password ?? randomBytes(10).toString('hex').slice(0, 16);
      const created = await ensureSupabaseUser(admin, email, temporary, rep);
      if (!created) return;
      const { uid, isNew } = created;

      // The address checks above cannot catch a Supabase identity already bound to
      // another account under a different address — a person who signed up as a merchant
      // with one email and is invited to administer with another. The unique indexes are
      // per-table, so nothing in the schema stops this; without the check the exchange
      // would resolve one person to two accounts and pick one of them.
      const [operatorByUid, clientByUid] = await Promise.all([
        operatorRepo.getBySupabaseUid(uid),
        clientRepo.getBySupabaseUid(uid),
      ]);
      if (operatorByUid || clientByUid) {
        await discardIdentity(admin, uid, isNew, req);
        return rep.code(409).send({ error: 'supabase_identity_in_use' });
      }

      let id: string;
      try {
        id = await operatorRepo.create({ name: body.name, email, supabaseUid: uid });
      } catch {
        // The invite is half-applied: an auth user exists with a password nobody was told.
        // Remove the one we made, then let the caller see the failure.
        await discardIdentity(admin, uid, isNew, req);
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      const operator = await operatorRepo.get(id);
      if (!operator) {
        await discardIdentity(admin, uid, isNew, req);
        throw Object.assign(new Error('operator_creation_failed'), { statusCode: 500 });
      }

      return rep.code(201).send({
        ...operatorToPublic(operator),
        temporaryPassword: body.password ? undefined : temporary,
      });
    },
  );

  /**
   * Grants admin to a Supabase user that already exists — the "pick from Supabase" path.
   *
   * No identity is created and no password is issued: the person already has a sign-in,
   * and this only adds the local grant that lets it administer the install. The invite
   * route above stays for when no Supabase user exists yet. The one-identity-one-person
   * refusals are the invite route's, because the duplicate it prevents is the same.
   */
  app.post(
    '/api/operators/from-supabase',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { uid } = fromSupabaseBody.parse(req.body);
      const admin = supabaseAdmin();
      if (!admin) return rep.code(503).send({ error: 'auth_unavailable' });

      type DirectoryUser = { id: string; email?: string | null; user_metadata?: Record<string, unknown> };
      let user: DirectoryUser | null = null;
      try {
        const { data, error } = await admin.auth.admin.getUserById(uid);
        if (!error && data?.user) user = data.user as DirectoryUser;
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      if (!user) return rep.code(404).send({ error: 'supabase_user_not_found' });

      const email = normalizeEmail(user.email ?? '');
      if (!email.includes('@')) {
        return rep.code(400).send({ error: 'validation_error', issues: [{ message: 'user has no email' }] });
      }

      const [operatorByUid, clientByUid, operatorByEmail, clientByEmail] = await Promise.all([
        operatorRepo.getBySupabaseUid(uid),
        clientRepo.getBySupabaseUid(uid),
        operatorRepo.findByEmail(email),
        clientRepo.findByEmail(email),
      ]);
      if (operatorByUid || operatorByEmail) return rep.code(409).send({ error: 'operator_already_exists' });
      if (clientByUid || clientByEmail) return rep.code(409).send({ error: 'email_in_use_by_client' });

      const name =
        (user.user_metadata?.name as string) ||
        (user.user_metadata?.full_name as string) ||
        email.split('@')[0];

      let id: string;
      try {
        id = await operatorRepo.create({ name, email, supabaseUid: uid });
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      const operator = await operatorRepo.get(id);
      if (!operator) throw Object.assign(new Error('operator_creation_failed'), { statusCode: 500 });
      return rep.code(201).send(operatorToPublic(operator));
    },
  );

  app.get(
    '/api/operators/:id',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { id } = idParam.parse(req.params);
      const operator = await operatorRepo.get(id);
      if (!operator) return rep.code(404).send({ error: 'operator_not_found' });
      return { operator: operatorToPublic(operator) };
    },
  );

  /**
   * Revokes an admin grant — the remove half of "pick admins from Supabase".
   *
   * Only the local row is deleted; the Supabase identity stays, because it may be a
   * merchant or an ordinary user and the grant was the only thing this surface added to
   * it. Deleting the row is enough to end access: `resolveOperatorSession` re-reads the
   * row on every guarded request and refuses when it is gone, so no explicit epoch bump
   * is needed and no live sid outlives the grant.
   *
   * This is the one destructive operation on the directory, and it reverses the earlier
   * no-delete stance deliberately: the directory is now a grant list, and a revoked
   * grant has no reason to keep occupying the list. The two self-lockout guards mirror
   * suspension — nobody may revoke themselves, and the last active admin stays.
   */
  app.delete(
    '/api/operators/:id',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { id } = idParam.parse(req.params);
      const operator = await operatorRepo.get(id);
      if (!operator) return rep.code(404).send({ error: 'operator_not_found' });
      if (id === callerOperatorId(req)) return rep.code(400).send({ error: 'cannot_remove_self' });
      if (operator.status === 'active' && (await activeOperatorCount()) <= 1) {
        return rep.code(400).send({ error: 'last_active_operator' });
      }
      const removed = await operatorRepo.remove(id);
      if (!removed) return rep.code(404).send({ error: 'operator_not_found' });
      return { ok: true };
    },
  );

  /**
   * Suspending an operator logs them out everywhere, not just at the next login — a
   * window full of live sids would otherwise keep acting until each one expired.
   * Reactivating restores login; those sessions stay dead because the epoch moved.
   */
  app.patch(
    '/api/operators/:id/status',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { id } = idParam.parse(req.params);
      const { status } = statusBody.parse(req.body);
      const operator = await operatorRepo.get(id);
      if (!operator) return rep.code(404).send({ error: 'operator_not_found' });

      if (status === 'suspended') {
        if (id === callerOperatorId(req)) {
          return rep.code(400).send({ error: 'cannot_suspend_self' });
        }
        // The last person who can sign in cannot be switched off. With one shared
        // password the equivalent accident was a bad deploy; here it is one click, and
        // the outcome is an install with no way back in short of direct SQL.
        if ((await activeOperatorCount()) <= 1) {
          return rep.code(400).send({ error: 'last_active_operator' });
        }
      }

      const done = await operatorRepo.setStatus(id, status);
      if (!done) return rep.code(404).send({ error: 'operator_not_found' });
      if (status === 'suspended') {
        try {
          await bumpOperatorEpoch(id);
        } catch {
          return rep.code(503).send({ error: 'auth_unavailable' });
        }
      }
      return { ok: true, status };
    },
  );

  /**
   * Sets a new password in Supabase and drops every session that operator holds.
   *
   * The epoch bump is the point, not a side effect: an admin resetting someone's
   * password because it may have leaked must also evict whoever was using it. The
   * admin performing the reset is unaffected — their own sid belongs to their own
   * epoch, which does not move.
   */
  app.post(
    '/api/operators/:id/reset-password',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { id } = idParam.parse(req.params);
      const { password } = passwordBody.parse(req.body);
      const operator = await operatorRepo.get(id);
      if (!operator) return rep.code(404).send({ error: 'operator_not_found' });
      if (!operator.supabaseUid) {
        // A row with no identity has no credential to reset; the invite never linked.
        return rep.code(409).send({ error: 'operator_has_no_identity' });
      }

      const admin = supabaseAdmin();
      if (!admin) return rep.code(503).send({ error: 'auth_unavailable' });
      try {
        const { error } = await admin.auth.admin.updateUserById(operator.supabaseUid, { password });
        if (error) return rep.code(503).send({ error: 'auth_unavailable' });
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }

      try {
        await bumpOperatorEpoch(id);
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      return { ok: true };
    },
  );

  /**
   * Logs one operator out of every device without changing their status — the "they
   * logged in somewhere I do not recognise" case. Distinct from suspending them, which
   * also blocks the next sign-in.
   */
  app.post(
    '/api/operators/:id/revoke-sessions',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { id } = idParam.parse(req.params);
      if (!(await operatorRepo.get(id))) return rep.code(404).send({ error: 'operator_not_found' });
      try {
        await bumpOperatorEpoch(id);
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      return { ok: true };
    },
  );

  /**
   * Logs every operator on this install out at once. The answer to a suspected
   * compromise, and the same thing `npm run revoke-operator-sessions` does from a
   * shell — reachable over HTTP because during an incident you may not have the box.
   *
   * Note the asymmetry with every other action here: this revokes the caller too, which
   * is the intent rather than a side effect. The BFF cookie still carries the old
   * global epoch, so the very next request is refused and the browser is sent to login.
   */
  app.post(
    '/api/operators/revoke-all',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (_req, rep) => {
      if (isMachineOperator((_req as any).principal)) {
        // A key is a machine with no operator row, so this call would leave the
        // person using it with no way to prove who they are. Refuse rather than
        // silently handing out a global revocation without attribution.
        return rep.code(400).send({ error: 'machine_principal_cannot_revoke_all' });
      }
      try {
        await bumpOperatorSessionEpoch();
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      return { ok: true };
    },
  );
}

/** The caller's operator id, or null when authenticated with the admin key. */
function callerOperatorId(req: unknown): string | null {
  const principal = (req as { principal?: { kind: string; operatorId: string | null } }).principal;
  return principal?.kind === 'operator' ? principal.operatorId : null;
}

/** How many operators could still sign in right now. */
async function activeOperatorCount(): Promise<number> {
  const rows = await operatorRepo.list();
  return rows.filter((r) => r.status === 'active').length;
}

/**
 * Creates the Supabase auth user for an invite (`email_confirm: true`, so the issued
 * temporary password works immediately), reusing an identity that already exists under
 * the email — a person invited twice, or whose earlier invite never landed.
 *
 * `isNew` reports whether this call created it, which is what {@link discardIdentity}
 * needs: an identity that already existed belongs to whoever had it before and must not
 * be deleted by a failed invite, while one we just made is ours to clean up.
 *
 * Returns null after sending a 503, so the route must `return` bare.
 */
async function ensureSupabaseUser(
  admin: NonNullable<ReturnType<typeof supabaseAdmin>>,
  email: string,
  password: string,
  rep: FastifyReply,
): Promise<{ uid: string; isNew: boolean } | null> {
  try {
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) {
      if (error.code === 'user_already_exists') {
        const existing = await findSupabaseUserByEmail(admin, email);
        if (!existing) {
          rep.code(503).send({ error: 'auth_unavailable' });
          return null;
        }
        return { uid: existing.id, isNew: false };
      }
      rep.code(503).send({ error: 'auth_unavailable' });
      return null;
    }
    return { uid: data.user.id, isNew: true };
  } catch {
    rep.code(503).send({ error: 'auth_unavailable' });
    return null;
  }
}

/**
 * Undoes the auth half of a failed invite.
 *
 * Best effort by necessity: the local write is what failed, so the request is already
 * being refused, and a cleanup that also fails must not turn a diagnosable 503 into a
 * hung one. Whatever is left behind is an identity with no local row, which cannot sign
 * in to anything and which the next invite for the same address will find and reuse.
 * The failure is logged because an unreclaimable account is worth knowing about.
 */
async function discardIdentity(
  admin: NonNullable<ReturnType<typeof supabaseAdmin>>,
  uid: string,
  isNew: boolean,
  req: { log: { error: (fields: unknown, message: string) => void } },
): Promise<void> {
  if (!isNew) return;
  try {
    await admin.auth.admin.deleteUser(uid);
  } catch (error) {
    req.log.error(
      { supabaseUserId: uid, error: error instanceof Error ? error.message : String(error) },
      'failed to remove the identity created for a rejected operator invite; it can sign in to nothing but will linger',
    );
  }
}
