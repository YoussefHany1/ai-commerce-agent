import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { getRedis } from './redis.js';
import { reqIp } from './rateLimit.js';
import { withTenant } from '../db/client.js';
import { stores } from '../db/schema.js';
import { storeRepo } from '../db/repos.js';
import { CLIENT_SESSION_HEADER, resolveClientSession } from './clientSession.js';
import { OPERATOR_SESSION_HEADER, resolveOperatorSession } from './operatorSession.js';

const BRUTE_WINDOW = 60;
const BRUTE_LIMIT = 30;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function headerValue(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  const out = Array.isArray(value) ? value[0] : value;
  return typeof out === 'string' && out ? out : undefined;
}

export async function resetApiKeyBruteCounter(ip: string): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.del(`rl:apikey:${ip}`);
  } catch {
    // best-effort; auth must not fail when Redis is unavailable
  }
}

/**
 * Matches the configured admin key, plus the previous generation while a rotation
 * is in flight. `safeEqual` short-circuits on length, so it is not a candidate for
 * a timing oracle here — the secret is not recoverable by measuring.
 */
function matchesAdminKey(provided: string): boolean {
  if (config.ADMIN_API_KEY && safeEqual(provided, config.ADMIN_API_KEY)) return true;
  if (config.ADMIN_API_KEY_PREVIOUS && safeEqual(provided, config.ADMIN_API_KEY_PREVIOUS)) return true;
  return false;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export const STORE_KEY_PATTERN = /^sk_live_[0-9a-f]{64}$/;

export type StoreIdRef = (req: FastifyRequest) => string | undefined;

async function verifyStoreApiKey(storeId: string, token: string): Promise<boolean> {
  const hash = sha256Hex(token);
  const hint = token.slice(-4);
  const [row] = await withTenant(storeId, (tx) =>
    tx
      .select({ hash: stores.apiKeyHash, hint: stores.apiKeyHint })
      .from(stores)
      .where(eq(stores.id, storeId)),
  );
  return row?.hash === hash && row?.hint === hint;
}

/**
 * Who the current request is acting as.
 *
 * `operator` is deliberately the widest type of the three, because an operator now
 * has two ways to prove it: a Supabase-backed session (a person, with an identity
 * worth putting in a log) or the shared admin key (a machine — a CLI, a script, a
 * cron job — which has no user behind it). `via` says which, and `operatorId` is
 * null for the key, so a route that wants to attribute an action to a person can
 * tell "nobody in particular" from "the operator whose name is on the invite".
 *
 * `store` is a merchant's API key, and `client` a dashboard account. Attached as
 * `(req as any).principal` by guards, read by the routes that must branch their
 * data access on it.
 */
export type Principal =
  | {
      kind: 'operator';
      /** The Supabase Auth user id behind a session, or null for the admin key. */
      operatorId: string | null;
      email: string | null;
      name: string | null;
      via: 'session' | 'admin_key';
    }
  | { kind: 'client'; clientId: string; name: string; email: string }
  | { kind: 'store'; storeId: string };

/** How an operator was authenticated, for the routes that need to tell them apart. */
export function isMachineOperator(principal: Principal | undefined): boolean {
  return principal?.kind === 'operator' && principal.via === 'admin_key';
}

function attachOperator(
  req: FastifyRequest,
  operator: { operatorId: string; email: string; name: string } | null,
): void {
  (req as any).principal = operator
    ? { kind: 'operator', operatorId: operator.operatorId, email: operator.email, name: operator.name, via: 'session' }
    : { kind: 'operator', operatorId: null, email: null, name: null, via: 'admin_key' };
}

export type DashboardOptions = {
  /**
   * Allow a store API key (`Bearer sk_live_…` or `x-api-key`) in addition to the
   * dashboard principals. Enabled only for storefront/agent endpoints — a store
   * key is scoped to one store and must never manage the client-account surface.
   */
  allowStoreKey?: boolean;
};

/**
 * Admin-key brute-force counter, shared by the two operator guards. Deliberately
 * best-effort: it is a backstop behind the escalating lockout the auth routes
 * apply, so a Redis outage must not turn a wrong key into a 500 — and must not
 * become a bypass either, since the credential check already failed.
 */
async function countApiKeyFailure(ip: string, reply: FastifyReply): Promise<void> {
  try {
    const redis = await getRedis();
    const key = `rl:apikey:${ip}`;
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, BRUTE_WINDOW);
    if (used > BRUTE_LIMIT) {
      reply.code(429).send({ error: 'rate_limit_exceeded' });
      return;
    }
  } catch {
    // never block on Redis failures; there is no credential to fall back on
  }
  reply.code(401).send({ error: 'unauthorized' });
}

/**
 * The guard for operator-administered routes.
 *
 * Accepts either an operator session (a person, signed in through Supabase) or the
 * shared admin key (a machine). The key is no longer how the dashboard signs in —
 * `web/lib/server/upstream.ts` forwards a session id instead — so what the key is
 * for now is scripting: `npm run client:create`, the runbook's curl examples, and
 * anything else that needs admin without a browser. Keeping it accepted here is
 * what makes that possible without a second set of routes.
 */
export async function requireOperator(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = await resolveOperatorSession(req, reply);
  if (session === undefined) return; // replied already
  if (session) {
    attachOperator(req, session);
    return;
  }

  const provided = headerValue(req, 'x-api-key') ?? bearerToken(req);
  if (provided && matchesAdminKey(provided)) {
    await resetApiKeyBruteCounter(reqIp(req));
    attachOperator(req, null);
    return;
  }

  if (!config.ADMIN_API_KEY) {
    reply.code(503).send({ error: 'auth_not_configured' });
    return;
  }
  await countApiKeyFailure(reqIp(req), reply);
}

function bearerToken(req: FastifyRequest): string | undefined {
  const bearer = headerValue(req, 'authorization');
  return bearer?.startsWith('Bearer ') ? bearer.slice('Bearer '.length) : undefined;
}

/**
 * The dashboard guard. Accepts, in order:
 *
 *   1. a valid client session           -> `client`
 *   2. a valid operator session          -> `operator` (a person)
 *   3. the admin key                     -> `operator` (a machine)
 *   4. (optionally) a store API key     -> `store`
 *
 * Precedence is deliberate: the narrowest credential wins. A request that carries
 * both a client session and an admin key is treated as the client, so a hostile or
 * stale session cannot ride the widest credential; a request carrying a dead
 * operator session is refused rather than falling through to the key, for the same
 * reason. A client that proves ownership of `storeIdRef(req)` (404
 * `store_not_found` when it does not — never 403, so a caller cannot enumerate
 * stores) is then trusted to drive exactly that store's data paths, which remain
 * tenant-scoped by `app.store_id`.
 *
 * Redis failure inside a session check rejects the request (503), mirroring
 * `resolveClientSession`: an outage must not become a bypass.
 */
export function requireDashboard(storeIdRef?: StoreIdRef, opts: DashboardOptions = {}) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Client session first: least privilege wins over every operator credential.
    // The BFF presents exactly one credential per request (a session header xor
    // the admin key), so a request carrying both is ambiguous and must be
    // resolved towards the narrower scope — a dead or hostile session fails the
    // ownership check instead of silently riding the admin key.
    const sid = headerValue(req, CLIENT_SESSION_HEADER);
    if (sid) {
      const client = await resolveClientSession(req, reply);
      if (!client) return;
      if (storeIdRef) {
        const storeId = storeIdRef(req);
        if (!storeId) return reply.code(400).send({ error: 'store_required' });
        const owned = await storeRepo.belongsToClient(storeId, client.clientId);
        if (!owned) return reply.code(404).send({ error: 'store_not_found' });
      }
      (req as any).principal = { kind: 'client', clientId: client.clientId, name: client.name, email: client.email };
      return;
    }

    // An operator session is the human credential. A dead one is a 401 and must not
    // degrade into the machine key, or revoking a person would silently promote the
    // browser to admin-by-key.
    if (headerValue(req, OPERATOR_SESSION_HEADER)) {
      const operator = await resolveOperatorSession(req, reply);
      if (operator === undefined) return;
      if (operator) {
        attachOperator(req, operator);
        return;
      }
      return reply.code(401).send({ error: 'invalid_session' });
    }

    const adminCandidate = headerValue(req, 'x-api-key') ?? bearerToken(req);
    if (adminCandidate && matchesAdminKey(adminCandidate)) {
      await resetApiKeyBruteCounter(reqIp(req));
      attachOperator(req, null);
      return;
    }

    if (opts.allowStoreKey) {
      const token = bearerToken(req) ?? headerValue(req, 'x-api-key');
      if (token) {
        const storeIdFromRef = storeIdRef ? storeIdRef(req) : undefined;
        const storeId = storeIdFromRef ?? headerValue(req, 'x-store-id');
        if (!storeId) return reply.code(400).send({ error: 'store_required' });
        if (!STORE_KEY_PATTERN.test(token)) return reply.code(401).send({ error: 'unauthorized' });
        const ok = await verifyStoreApiKey(storeId, token).catch(() => false);
        if (!ok) return reply.code(401).send({ error: 'unauthorized' });
        (req as any).principal = { kind: 'store', storeId };
        return;
      }
    }

    if (!config.ADMIN_API_KEY) {
      reply.code(503).send({ error: 'auth_not_configured' });
      return;
    }
    await countApiKeyFailure(reqIp(req), reply);
  };
}