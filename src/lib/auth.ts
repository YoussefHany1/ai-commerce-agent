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

export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!config.ADMIN_API_KEY) {
    reply.code(503).send({ error: 'auth_not_configured' });
    return;
  }
  const provided = headerValue(req, 'x-api-key');
  const valid = typeof provided === 'string' && matchesAdminKey(provided);
  if (valid) {
    await resetApiKeyBruteCounter(reqIp(req));
    return;
  }

  try {
    const redis = await getRedis();
    const key = `rl:apikey:${reqIp(req)}`;
    const used = await redis.incr(key);
    if (used === 1) await redis.expire(key, BRUTE_WINDOW);
    if (used > BRUTE_LIMIT) {
      reply.code(429).send({ error: 'rate_limit_exceeded' });
      return;
    }
  } catch {
    // never block on Redis failures; the key check above already failed
  }

  reply.code(401).send({ error: 'unauthorized' });
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
 * Who the current request is acting as. `operator` and `store` are the two
 * pre-existing presentation stocks (admin key, store API key); `client` is the
 * dashboard account introduced by the tenancy work. Attached to `(req as any).principal`
 * by guards, read by the routes that must branch their data access on it.
 */
export type Principal =
  | { kind: 'client'; clientId: string; name: string; email: string }
  | { kind: 'operator' }
  | { kind: 'store'; storeId: string };

export type DashboardOptions = {
  /**
   * Allow a store API key (`Bearer sk_live_…` or `x-api-key`) in addition to the
   * dashboard principals. Enabled only for storefront/agent endpoints — a store
   * key is scoped to one store and must never manage the client-account surface.
   */
  allowStoreKey?: boolean;
};

/**
 * The dashboard guard. Accepts, in order:
 *
 *   1. the admin key                    -> `operator`
 *   2. a valid client session           -> `client`
 *   3. (optionally) a store API key     -> `store`
 *
 * Precedence is deliberate. A request that carries both an admin key and a
 * (possibly hostile) client session is treated as the session: the client scope
 * is the least privilege, so it wins rather than the highest certificate. A
 * client that proves ownership of `storeIdRef(req)` (404 `store_not_found` when it
 * does not — never 403, so a caller cannot enumerate stores) is then trusted to
 * drive exactly that store's data paths, which remain tenant-scoped by `app.store_id`.
 *
 * Redis failure inside a client-session check rejects the request (503), mirroring
 * `resolveClientSession`: an outage must not become a bypass.
 */
export function requireDashboard(storeIdRef?: StoreIdRef, opts: DashboardOptions = {}) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // The client session is checked before the admin key: least privilege wins.
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

    const apiKey = headerValue(req, 'x-api-key');
    const bearer = headerValue(req, 'authorization');
    const bearerToken = bearer?.startsWith('Bearer ') ? bearer.slice('Bearer '.length) : undefined;
    const adminCandidate = apiKey ?? bearerToken;
    if (adminCandidate && matchesAdminKey(adminCandidate)) {
      await resetApiKeyBruteCounter(reqIp(req));
      (req as any).principal = { kind: 'operator' };
      return;
    }

    if (opts.allowStoreKey) {
      const token = bearerToken ?? apiKey;
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
    try {
      const redis = await getRedis();
      const key = `rl:apikey:${reqIp(req)}`;
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
  };
}