import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { getRedis } from './redis.js';
import { reqIp } from './rateLimit.js';

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

export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!config.ADMIN_API_KEY) {
    reply.code(503).send({ error: 'auth_not_configured' });
    return;
  }
  const header = req.headers['x-api-key'];
  const provided = Array.isArray(header) ? header[0] : header;
  const valid = typeof provided === 'string' && safeEqual(provided, config.ADMIN_API_KEY);
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