import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getRedis } from './redis.js';
import { operatorRepo } from '../db/repos.js';

/**
 * Operator sessions (Redis).
 *
 * Two epochs, and the difference is the whole point of this rewrite:
 *
 *   * the *global* epoch (`op:sess:epoch`) is still one key for the whole install.
 *     Bumping it logs out every operator at once, which is what
 *     `scripts/revoke-operator-sessions.ts` does and what a suspected compromise
 *     needs. It is checked on every request.
 *   * the *per-operator* epoch (`op:sess:epoch:<id>`) is what makes an operator a
 *     person rather than a role: suspending one, or revoking one person's sessions,
 *     moves only their epoch. The shared password this replaced had no such
 *     notion — changing it locked everyone out, and there was no way to lock out
 *     just the person you meant.
 *
 * A session is a `sid` minted here, and the per-login granularity is what lets one
 * browser be logged out (or an operator sign out of one device) without touching
 * the others. This is the operator analogue of `src/lib/clientSession.ts`, plus the
 * global epoch that predates it.
 *
 * The web BFF verifies the `aca_session` cookie (signature + both epochs) before it
 * forwards a request, then forwards the sid in `OPERATOR_SESSION_HEADER`. This
 * module is the authoritative check on the API side: it re-resolves the sid against
 * Redis and re-reads `operators.status`, so a suspension takes effect even if it
 * was done outside the API (direct SQL, a script, the Supabase dashboard).
 *
 * Every read fails closed. A Redis outage rejects the request rather than letting
 * a session through unverified.
 */

/** Header the web BFF sends for an operator session. */
export const OPERATOR_SESSION_HEADER = 'x-operator-session';

/** Install-wide epoch: bump to log every operator out at once. */
export const OPERATOR_EPOCH_KEY = 'op:sess:epoch';

const SID_PREFIX = 'op:sess:';
const EPOCH_PREFIX = 'op:sess:epoch:';

const GENERATED_BYTES = 16;

function hashSid(sid: string): string {
  return createHash('sha256').update(sid).digest('hex');
}

export type OperatorSession = {
  operatorId: string;
  /** The per-operator epoch at issue time; a bump invalidates this session. */
  epoch: string;
  /**
   * The install-wide epoch at issue time, recorded in Redis and not just in the
   * cookie. It has to be here as well as in the cookie: the BFF can compare against
   * its own copy of the global epoch, but a request that reaches this service
   * directly (curl with a stolen sid, a script, a future service) never passed
   * through the BFF, so without this field `bumpOperatorSessionEpoch()` would end
   * every dashboard session while leaving every live sid valid against the API.
   */
  globalEpoch: string;
};

function getSid(req: FastifyRequest): string | undefined {
  const header = req.headers[OPERATOR_SESSION_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Returns the install-wide epoch, creating it on first use.
 *
 * A missing key is seeded with a random value rather than a constant. That makes a
 * Redis flush fail closed: previously issued cookies carry the old epoch and stop
 * verifying, rather than resurrecting revoked sessions.
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

/** Logs out every operator on this install. `scripts/revoke-operator-sessions.ts`. */
export async function bumpOperatorSessionEpoch(): Promise<string> {
  const redis = await getRedis();
  // Rotate rather than INCR: the seed is a random hex string, which Redis INCR
  // would refuse ("value is not an integer"). Invalidation only needs inequality.
  const fresh = randomBytes(GENERATED_BYTES).toString('hex');
  await redis.set(OPERATOR_EPOCH_KEY, fresh);
  return fresh;
}

/** The current epoch for one operator, seeded randomly on first use. */
export async function ensureOperatorEpoch(operatorId: string): Promise<string> {
  const redis = await getRedis();
  const key = `${EPOCH_PREFIX}${operatorId}`;
  const existing = await redis.get(key);
  if (existing) return existing;
  const fresh = randomBytes(GENERATED_BYTES).toString('hex');
  await redis.set(key, fresh, { NX: true });
  return (await redis.get(key)) ?? fresh;
}

/** Invalidates every live session for one operator. Suspension and revocation call this. */
export async function bumpOperatorEpoch(operatorId: string): Promise<string> {
  const redis = await getRedis();
  const fresh = randomBytes(GENERATED_BYTES).toString('hex');
  await redis.set(`${EPOCH_PREFIX}${operatorId}`, fresh);
  return fresh;
}

/** Values returned to the caller which must mint the session. Only this service mints a sid. */
export type NewOperatorSession = {
  sid: string;
  expiresIn: number;
  /** The per-operator epoch the sid is bound to. */
  epoch: string;
  /** The install-wide epoch the cookie is also bound to, so one bump logs everyone out. */
  globalEpoch: string;
};

export async function createOperatorSession(operatorId: string): Promise<NewOperatorSession> {
  const [epoch, globalEpoch] = await Promise.all([
    ensureOperatorEpoch(operatorId),
    ensureOperatorSessionEpoch(),
  ]);
  const sid = randomBytes(32).toString('hex');
  const redis = await getRedis();
  const payload: OperatorSession = { operatorId, epoch, globalEpoch };
  await redis.set(`${SID_PREFIX}${hashSid(sid)}`, JSON.stringify(payload), {
    EX: config.OPERATOR_SESSION_TTL_SECONDS,
  });
  return { sid, expiresIn: config.OPERATOR_SESSION_TTL_SECONDS, epoch, globalEpoch };
}

export async function getOperatorSession(sid: string): Promise<OperatorSession | null> {
  const redis = await getRedis();
  const raw = await redis.get(`${SID_PREFIX}${hashSid(sid)}`);
  if (!raw) return null;
  let stored: OperatorSession;
  try {
    stored = JSON.parse(raw) as OperatorSession;
  } catch {
    return null;
  }
  if (
    typeof stored.operatorId !== 'string' ||
    typeof stored.epoch !== 'string' ||
    typeof stored.globalEpoch !== 'string'
  ) {
    // A payload without the global epoch predates this field; refuse it rather than
    // treating a missing value as a match, so upgrading cannot leave a live sid
    // outside the reach of a revoke-all.
    return null;
  }
  // Both epochs, or the session is dead. Read in parallel: two round trips to Redis
  // on every guarded request is one too many.
  const [epoch, globalEpoch] = await Promise.all([
    ensureOperatorEpoch(stored.operatorId),
    ensureOperatorSessionEpoch(),
  ]);
  if (stored.epoch !== epoch) return null;
  if (stored.globalEpoch !== globalEpoch) return null;
  return stored;
}

export async function revokeOperatorSession(sid: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(`${SID_PREFIX}${hashSid(sid)}`);
}

/**
 * Resolves the caller's sid to an operator identity.
 *
 * Mirrors `resolveClientSession`, including the deliberate uniformity: a suspended
 * operator and a revoked session are indistinguishable from outside, so the login
 * form cannot be used to enumerate which addresses have admin accounts.
 *
 *   - missing header  -> 401 `unauthorized`; the route's guard structure decides
 *                        whether to fall back to the admin key (see requireDashboard)
 *   - Redis down      -> 503 `auth_unavailable`; an outage must not become a bypass
 *   - revoked session -> 401 `invalid_session`
 *   - suspended       -> 401 `account_suspended`
 */
export async function resolveOperatorSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ operatorId: string; email: string; name: string } | null> {
  const sid = getSid(req);
  if (!sid) return null;

  let session: OperatorSession | null;
  try {
    session = await getOperatorSession(sid);
  } catch {
    reply.code(503).send({ error: 'auth_unavailable' });
    return undefined as unknown as null;
  }

  if (!session) {
    reply.code(401).send({ error: 'invalid_session' });
    return undefined as unknown as null;
  }

  let operator: { id: string; name: string; email: string; status: string } | null;
  try {
    operator = await operatorRepo.get(session.operatorId);
  } catch {
    reply.code(503).send({ error: 'auth_unavailable' });
    return undefined as unknown as null;
  }

  if (!operator || operator.status !== 'active') {
    reply.code(401).send({ error: 'account_suspended' });
    return undefined as unknown as null;
  }

  return { operatorId: operator.id, email: operator.email, name: operator.name };
}

export { getSid };
