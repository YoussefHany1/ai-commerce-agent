import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getRedis } from './redis.js';
import { config } from '../config.js';

export type CustomerSession = {
  storeId: string;
  customerId: string | null;
  conversationId: string;
};

const PREFIX = 'sess:';
const IDX_PREFIX = 'sess:idx:';

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(session: CustomerSession, ttlSec = config.SESSION_TTL_SECONDS): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hash(token);
  const redis = await getRedis();
  await redis.set(`${PREFIX}${tokenHash}`, JSON.stringify(session), { EX: ttlSec });
  if (session.customerId) {
    const idxKey = `${IDX_PREFIX}${session.storeId}:${session.customerId}`;
    await redis.sAdd(idxKey, tokenHash);
    await redis.expire(idxKey, ttlSec);
  }
  return token;
}

export async function getSession(token: string | undefined): Promise<CustomerSession | null> {
  if (!token) return null;
  const redis = await getRedis();
  const raw = await redis.get(`${PREFIX}${hash(token)}`);
  if (!raw) return null;
  return JSON.parse(raw) as CustomerSession;
}

export async function revokeSession(token: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(`${PREFIX}${hash(token)}`);
}

export async function revokeSessionsForCustomers(storeId: string, customerIds: string[]): Promise<void> {
  if (!customerIds.length) return;
  const redis = await getRedis();
  for (const customerId of customerIds) {
    const idxKey = `${IDX_PREFIX}${storeId}:${customerId}`;
    const hashes = await redis.sMembers(idxKey);
    if (hashes.length) await redis.del(hashes.map((h) => `${PREFIX}${h}`));
    await redis.del(idxKey);
  }
}

function bearerToken(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (!auth) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : undefined;
}

export async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = bearerToken(req);
  let session: CustomerSession | null = null;
  try {
    session = token ? await getSession(token) : null;
  } catch {
    reply.code(503).send({ error: 'session_store_unavailable' });
    return;
  }
  if (!session) {
    reply.code(401).send({ error: 'invalid_session' });
    return;
  }
  (req as any).session = session;
}