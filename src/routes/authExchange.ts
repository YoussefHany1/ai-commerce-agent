import { FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { clientRepo, operatorRepo } from '../db/repos.js';
import {
  bumpClientSessionEpoch,
  createClientSession,
  getSid as getClientSid,
  revokeClientSession,
} from '../lib/clientSession.js';
import {
  bumpOperatorEpoch,
  createOperatorSession,
  getSid as getOperatorSid,
  revokeOperatorSession,
} from '../lib/operatorSession.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { normalizeEmail } from './clientAuth.js';

/**
 * The one way a Supabase session token becomes one of ours, plus the one logout.
 *
 * Operators and clients used to have two exchange routes, and that was a problem in
 * itself: the Google sign-in flow is one HTTP redirect for both, so whichever route
 * the callback called decided what a person could become, and getting it wrong meant
 * a client could try to arrive as an operator (or an operator could not arrive at
 * all). Resolving the identity *first* and letting the lookup decide removes the
 * choice. One token, one lookup, one answer: `kind` names the account it reached, and
 * the response carries the sid and epochs for that account's session.
 *
 * Both tables are consulted and the answer is a genuine intersection of what matched,
 * not a short-circuit: the two `supabase_uid` unique indexes are per-table, so nothing
 * in the schema stops the same auth user having been linked on both sides (a bad
 * import, two half-completed admin actions, an address reused after a merge). Silently
 * preferring the operator would hand an administrator's cookie to a merchant who
 * happens to share the identity, so a conflict is refused instead and logged. The
 * admin routes refuse to create the situation; this is what catches it if the data
 * arrived some other way.
 *
 * `rotate: true` is how a password reset invalidates every other session: the
 * identity's epoch is bumped and the new session is minted against the moved value,
 * in one round trip. That replaces the old `client/reset-complete` + `client/exchange`
 * pair, and it is also what makes the reset flow work for an operator at all — their
 * sessions live on a different epoch, which the client-only route could not reach.
 */

const exchangeBody = z.object({
  accessToken: z.string().min(1).max(8192),
  /** Bump the identity's epoch first: use on password reset, never on plain sign-in. */
  rotate: z.boolean().optional(),
});

type ResolvedIdentity = {
  kind: 'operator' | 'client';
  id: string;
  name: string;
  email: string;
};

export async function authExchange(app: FastifyInstance) {
  /**
   * Trades a Supabase session token (Google OAuth callback, a completed reset, a
   * phone sign-in) for one of our sids.
   *
   * The token is dropped here: what persists is a Redis sid bound to an epoch, which
   * the BFF puts in an HTTP-only cookie and the API re-resolves on every call. The
   * browser never holds a Supabase token, so a stolen dashboard cookie is not a
   * stolen identity-provider session.
   */
  app.post('/api/auth/exchange', async (req, rep) => {
    const parsed = exchangeBody.safeParse(req.body ?? {});
    if (!parsed.success) return rep.code(400).send({ error: 'validation_error', issues: parsed.error.issues });

    const identity = await resolveIdentity(parsed.data.accessToken, req, rep);
    if (!identity) return;

    if (identity.kind === 'operator') {
      let session: { sid: string; expiresIn: number; epoch: string; globalEpoch: string };
      try {
        if (parsed.data.rotate) await bumpOperatorEpoch(identity.id);
        session = await createOperatorSession(identity.id);
      } catch {
        return rep.code(503).send({ error: 'auth_unavailable' });
      }
      return {
        ok: true,
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
      if (parsed.data.rotate) await bumpClientSessionEpoch(identity.id);
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

  /**
   * Signs this device out, for either principal.
   *
   * One route because the caller has exactly one sid and should not have to know
   * which kind of session it is discarding; the other principal's header is simply
   * absent, and a missing sid is refused rather than silently "succeeding" on a
   * request that authenticated nothing.
   */
  app.post('/api/auth/logout', async (req, rep) => {
    const clientSid = getClientSid(req);
    const operatorSid = getOperatorSid(req);
    if (!clientSid && !operatorSid) return rep.code(401).send({ error: 'unauthorized' });
    try {
      if (clientSid) await revokeClientSession(clientSid);
      if (operatorSid) await revokeOperatorSession(operatorSid);
    } catch {
      // 503 rather than 200: a sid that outlives a failed revocation is a live
      // session the user believes they just ended. The BFF clears its cookie
      // regardless, so the visible effect is still a sign-out.
      return rep.code(503).send({ error: 'auth_unavailable' });
    }
    return { ok: true };
  });
}

/**
 * Resolves a Supabase access token to exactly one local account, or replies and
 * returns null.
 *
 * Four outcomes, deliberately: 503 when Supabase or the database is unreachable (an
 * outage, which the sign-in form reports as "try again"), 401 when the token does not
 * verify, 401 when it verifies but reaches no account — or a suspended one, and 401 when
 * it reaches two. The first three are one indistinguishable answer to the caller, so this
 * route cannot be used to learn which addresses exist at the identity provider or which
 * of them administer this install; the last is a data-integrity refusal and is logged
 * rather than explained.
 *
 * The email fallback is for an invite written before its identity was linked. It runs
 * only after a token that already proved the address, and it links rather than
 * creates: signing in with a valid token for an address nobody invited still gets
 * nothing. It also declines to link when an operator holds the address — an operator
 * with a stale or unlinked identity is a real possibility, and silently creating a
 * merchant row for their address would be the same privilege split this route exists
 * to prevent.
 */
async function resolveIdentity(
  accessToken: string,
  req: FastifyRequest,
  rep: FastifyReply,
): Promise<ResolvedIdentity | null> {
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
    // Both sides in one round trip: deciding "which kind" is only meaningful once both
    // have been asked.
    const [operator, clientByUid] = await Promise.all([
      operatorRepo.getBySupabaseUid(userId),
      clientRepo.getBySupabaseUid(userId),
    ]);

    if (operator && clientByUid) {
      // Refuse rather than pick. Whichever side won, the other would be unreachable for
      // as long as the duplicate stands, and the operator-first order would mean the
      // merchant's session silently administering the install.
      req.log.error(
        { supabaseUserId: userId, operatorId: operator.id, clientId: clientByUid.id },
        'supabase identity linked to both an operator and a client; refusing to resolve',
      );
      rep.code(401).send({ error: 'invalid_credentials' });
      return null;
    }

    if (operator) {
      if (operator.status !== 'active') {
        rep.code(401).send({ error: 'invalid_credentials' });
        return null;
      }
      return { kind: 'operator', id: operator.id, name: operator.name, email: operator.email };
    }

    // A client matched by uid is authoritative even when suspended: falling through to
    // the email fallback here would let a suspended account sign in through its address.
    let client = clientByUid;
    if (!client && userEmail) {
      const email = normalizeEmail(userEmail);
      const [byEmail, operatorByEmail] = await Promise.all([
        clientRepo.findByEmail(email),
        operatorRepo.findByEmail(email),
      ]);
      if (byEmail && !operatorByEmail) {
        await clientRepo.setSupabaseUid(byEmail.id, userId);
        client = byEmail;
      }
    }
    if (!client || client.status !== 'active') {
      rep.code(401).send({ error: 'invalid_credentials' });
      return null;
    }
    return { kind: 'client', id: client.id, name: client.name, email: client.email };
  } catch {
    rep.code(503).send({ error: 'auth_unavailable' });
    return null;
  }
}
