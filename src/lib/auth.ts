import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { getRedis } from './redis.js';
import { reqIp } from './rateLimit.js';
import { withTenant } from '../db/client.js';
import { stores } from '../db/schema.js';

const BRUTE_WINDOW = 60;
const BRUTE_LIMIT = 30;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
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
  const header = req.headers['x-api-key'];
  const provided = Array.isArray(header) ? header[0] : header;
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

export function requireStoreOrOperator(storeIdRef: StoreIdRef) {
  return async function preHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!config.ADMIN_API_KEY) {
      reply.code(503).send({ error: 'auth_not_configured' });
      return;
    }
    const header = req.headers.authorization;
    const bearer = Array.isArray(header) ? header[0] : header;
    let token = bearer?.startsWith('Bearer ') ? bearer.slice('Bearer '.length) : null;

    if (!token) {
      const apiKeyHeader = req.headers['x-api-key'];
      token = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader ?? null;
    }

    if (!token) return reply.code(401).send({ error: 'unauthorized' });
    if (matchesAdminKey(token)) {
      await resetApiKeyBruteCounter(reqIp(req));
      return;
    }
    const storeIdFromRef = storeIdRef(req);
    const storeIdHeader = req.headers['x-store-id'];
    const storeId = storeIdFromRef ?? (Array.isArray(storeIdHeader) ? storeIdHeader[0] : storeIdHeader);
    if (!storeId) return reply.code(400).send({ error: 'store_required' });
    if (!STORE_KEY_PATTERN.test(token)) return reply.code(401).send({ error: 'unauthorized' });
    const ok = await verifyStoreApiKey(storeId, token).catch(() => false);
    if (!ok) return reply.code(401).send({ error: 'unauthorized' });
  };
}