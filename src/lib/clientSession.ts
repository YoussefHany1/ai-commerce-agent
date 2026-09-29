import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getRedis } from './redis.js';
import { clientRepo } from '../db/repos.js';

/**
 * Client dashboard sessions (Redis).
 *
 * This is the client analogue of `src/lib/operatorSession.ts`, plus a per-login
 * token so a single browser session can be revoked without logging the whole
 * account out.
 *
 * The web BFF verifies the `aca_session` cookie (signature + this store's epoch)
 * before it forwards a request, then forwards the sid from the cookie in
 * `CLIENT_SESSION_HEADER`. This module is the authoritative check on the API side:
 * it re-resolves the sid against Redis and, because it runs in the process that
 * owns the DB, it also re-reads the client's `status` so a suspension takes
 * effect even if it was done outside the API (direct SQL, a script, a future
 * admin surface).
 *
 * Every read paths deliberately fail closed: a Redis outage rejects the request
 * rather than letting a session through unverified (see `requireClientSession`).
 */

/** Header the web BFF sends for a client (non-operator) session. */
export const CLIENT_SESSION_HEADER = 'x-client-session';

const SID_PREFIX = 'cli:sess:';
const EPOCH_PREFIX = 'cli:sess:epoch:';

function hashSid(sid: string): string {
  return createHash('sha256').update(sid).digest('hex');
}

export type ClientSession = {
  clientId: string;
  /** Value of the account's epoch at issue time; a bump invalidates this session. */
  epoch: string;
};

function getSid(req: FastifyRequest): string | undefined {
  const header = req.headers[CLIENT_SESSION_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Returns the current epoch for an account, creating it on first use with a
 * random seed. A Redis flush therefore fails closed: previously issued sids carry
 * the old epoch and stop verifying, exactly like the operator epoch at
 * `src/lib/operatorSession.ts`.
 */
export async function ensureClientSessionEpoch(clientId: string): Promise<string> {
  const redis = await getRedis();
  const key = `${EPOCH_PREFIX}${clientId}`;
  const existing = await redis.get(key);
  if (existing) return existing;
  const fresh = randomBytes(16).toString('hex');
  await redis.set(key, fresh, { NX: true });
  return (await redis.get(key)) ?? fresh;
}

/** Invalidates every live session for an account. Suspension and password reset call this. */
export async function bumpClientSessionEpoch(clientId: string): Promise<string> {
  const redis = await getRedis();
  // Rotate rather than INCR: the seed is a random hex string, which Redis INCR
  // would refuse ("value is not an integer"). Invalidation only needs inequality,
  // and the new value becomes the epoch that freshly issued sids bind to.
  const fresh = randomBytes(16).toString('hex');
  await redis.set(`${EPOCH_PREFIX}${clientId}`, fresh);
  return fresh;
}

/**
 * Values returned to the caller which must mint the session. The cookie is made
 * by the web BFF; only this service ever produces the sid that unlocks it.
 */
export type NewClientSession = {
  sid: string;
  expiresIn: number;
  /** The account epoch the sid is bound to — the cookie mints against it too. */
  epoch: string;
};

export async function createClientSession(clientId: string): Promise<NewClientSession> {
  const epoch = await ensureClientSessionEpoch(clientId);
  const sid = randomBytes(32).toString('hex');
  const redis = await getRedis();
  const payload: ClientSession = { clientId, epoch };
  await redis.set(`${SID_PREFIX}${hashSid(sid)}`, JSON.stringify(payload), { EX: config.CLIENT_SESSION_TTL_SECONDS });
  return { sid, expiresIn: config.CLIENT_SESSION_TTL_SECONDS, epoch };
}

export async function getClientSession(sid: string): Promise<ClientSession | null> {
  const redis = await getRedis();
  const raw = await redis.get(`${SID_PREFIX}${hashSid(sid)}`);
  if (!raw) return null;
  let stored: ClientSession;
  try {
    stored = JSON.parse(raw) as ClientSession;
  } catch {
    return null;
  }
  if (typeof stored.clientId !== 'string' || typeof stored.epoch !== 'string') return null;
  const epoch = await ensureClientSessionEpoch(stored.clientId);
  if (stored.epoch !== epoch) return null;
  return stored;
}

export async function revokeClientSession(sid: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(`${SID_PREFIX}${hashSid(sid)}`);
}

/**
 * Rotates the account's epoch (logging every other device out) but re-mints the
 * given sid against the new epoch, so the caller stays signed in. Used after a
 * password change. The new epoch is returned for the web BFF to re-sign into the
 * cookie.
 */
export async function bumpClientSessionAndKeep(sid: string, clientId: string): Promise<string> {
  const redis = await getRedis();
  const epoch = await bumpClientSessionEpoch(clientId);
  const payload: ClientSession = { clientId, epoch };
  await redis.set(`${SID_PREFIX}${hashSid(sid)}`, JSON.stringify(payload), {
    EX: config.CLIENT_SESSION_TTL_SECONDS,
    XX: true,
  });
  return epoch;
}

/**
 * The guard. Attaches `(req as any).client = { clientId, name, email }` on
 * success and returns without sending a response.
 *
 * Three failure modes, all deliberate:
 *   - missing header   -> 401 `unauthorized`; the route's caller structure decides
 *                          whether to fall back to API-key auth (see `requireDashboard`)
 *   - Redis down       -> 503 `auth_unavailable`; an outage must not become a bypass
 *   - revoked session  -> 401 `invalid_session`
 *   - suspended account-> 401 `account_suspended`; uniform with the above so the
 *                          caller cannot distinguish "logged out" from "disabled"
 */
export async function resolveClientSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ clientId: string; name: string; email: string } | null> {
  const sid = getSid(req);
  if (!sid) return null;

  let session: ClientSession | null;
  try {
    session = await getClientSession(sid);
  } catch {
    reply.code(503).send({ error: 'auth_unavailable' });
    return undefined as unknown as null;
  }

  if (!session) {
    reply.code(401).send({ error: 'invalid_session' });
    return undefined as unknown as null;
  }

  let client: { id: string; name: string; email: string; status: string } | null;
  try {
    client = await clientRepo.getForAuth(session.clientId);
  } catch {
    reply.code(503).send({ error: 'auth_unavailable' });
    return undefined as unknown as null;
  }

  if (!client || client.status !== 'active') {
    reply.code(401).send({ error: 'account_suspended' });
    return undefined as unknown as null;
  }

  return { clientId: client.id, name: client.name, email: client.email };
}

export { getSid };