import { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  storeRepo,
  catalogRepo,
  conversationRepo,
  storeToPublic,
  jobsRepo,
} from '../db/repos.js';
import { getCommerceAdapter } from '../integrations/factory.js';
import { answerWithTools, toChatHistory } from '../services/agent.js';
import { retrieve, embedMissingCatalog } from '../services/retrieval.js';
import { dbPing, redisPing, rlsPing } from '../lib/health.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { requireApiKey, requireStoreOrOperator, sha256Hex } from '../lib/auth.js';
import { requireSession, type CustomerSession } from '../lib/session.js';
import { config } from '../config.js';

const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };
const chatWindow = { limit: config.RATE_LIMIT_CHAT_PER_MIN, windowSec: 60 };
const storeIdParam = z.object({ storeId: z.string().min(1) });

export async function api(app: FastifyInstance) {
  app.get('/api/health', async (_req, reply) => {
    const [dbOk, redisOk, rlsOk] = await Promise.all([dbPing(), redisPing(), rlsPing()]);
    const deps = { db: dbOk, redis: redisOk, rls: rlsOk };
    // A degraded RLS layer is a 503, not a footnote in the body. Reporting it
    // alongside a 200 status is what let an owner connection that ignored every
    // tenant policy look healthy; Dockerfile's HEALTHCHECK keys off this status,
    // so failing here takes the container out of rotation instead.
    if (!dbOk || !redisOk || !rlsOk) {
      return reply.code(503).send({ status: 'error', ...deps, time: new Date().toISOString() });
    }
    return {
      status: 'ok',
      db: 'connected',
      ok: true,
      deps,
      uptime: process.uptime(),
      time: new Date().toISOString(),
    };
  });

  app.get(
    '/api/stores',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async () => {
    const rows = await storeRepo.list();
    return rows.map(storeToPublic);
  });

  app.post(
    '/api/stores',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        platform: z.enum(['shopify', 'salla', 'zid']),
        shopDomain: z.string().optional(),
        accessToken: z.string().optional(),
      })
      .parse(req.body);
    const id = await storeRepo.create(body);

    // Manually added stores never went through saveInstall, so they miss the
    // install-time kick. Enqueue the order backfill here too, otherwise a store
    // added from the dashboard sits on zero revenue until the next 15-minute
    // orderSync tick notices its null cursor.
    try {
      await jobsRepo.enqueue(id, 'order.sync', {}, { runAt: new Date() });
    } catch (err) {
      app.log.warn({ err, storeId: id }, 'order.sync enqueue failed for new store');
    }

    return { id };
  });

  app.delete(
    '/api/stores/:storeId',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { storeId } = storeIdParam.parse(req.params);
      const store = await storeRepo.get(storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      await storeRepo.remove(storeId);
      return { ok: true };
    },
  );

  app.post(
    '/api/stores/:storeId/keys',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { storeId } = storeIdParam.parse(req.params);
      const store = await storeRepo.get(storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      const key = `sk_live_${randomBytes(32).toString('hex')}`;
      await storeRepo.setApiKey(storeId, sha256Hex(key), key.slice(-4));
      return { storeId, key, apiKeyHint: key.slice(-4) };
    },
  );

  app.get(
    '/api/stores/:storeId/keys',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { storeId } = storeIdParam.parse(req.params);
      const store = await storeRepo.get(storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      return { storeId, apiKeyHint: await storeRepo.getApiKeyHint(storeId) };
    },
  );

  app.delete(
    '/api/stores/:storeId/keys',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { storeId } = storeIdParam.parse(req.params);
      const store = await storeRepo.get(storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      await storeRepo.clearApiKey(storeId);
      return { ok: true };
    },
  );

  app.get(
    '/api/products/:storeId',
    { preHandler: [requireStoreOrOperator((req) => (req.params as { storeId?: string }).storeId), storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { storeId } = storeIdParam.parse(req.params);
      const store = await storeRepo.get(storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      let list = await catalogRepo.list(storeId);
      const adapter = await getCommerceAdapter(storeId);
      if (adapter) {
        list = await adapter.listProducts();
        await catalogRepo.upsert(storeId, list, (await catalogRepo.syncVersion(storeId)) + 1);
        await catalogRepo.markSynced(storeId);
      }
      await embedMissingCatalog(storeId);
      return list;
    },
  );

  app.post(
    '/api/chat',
    { preHandler: [requireSession, storeRateLimitWindow('chat', chatWindow)] },
    async (req, rep) => {
      const body = z.object({ message: z.string().min(1).max(2000) }).parse(req.body);
      const sess = (req as any).session as CustomerSession;
      const store = await storeRepo.get(sess.storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      const found = await retrieve(body.message, sess.storeId);
      const list = found.map((f) => f.product);
      const conversationId = sess.conversationId;
      const history = toChatHistory(await conversationRepo.history(sess.storeId, conversationId, 10));
      await conversationRepo.addMessage({ storeId: sess.storeId, conversationId, role: 'user', content: body.message });
      const reply = await answerWithTools(sess.storeId, body.message, history);
      await conversationRepo.addMessage({ storeId: sess.storeId, conversationId, role: 'assistant', content: reply });
      return { reply, products: list };
    },
  );
}