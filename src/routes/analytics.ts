import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { storeRepo } from '../db/repos.js';
import { allowsAnalytics, attributionRows, conversionLag, funnelByChannel, getDailyMetrics, recordClick, topProducts } from '../services/analytics.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { requireApiKey } from '../lib/auth.js';
import { requireSession, type CustomerSession } from '../lib/session.js';
import { config } from '../config.js';

const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };

const gate = async (req: any, reply: any) => {
  const storeId = ((req as any).params as any)?.storeId ?? ((req as any).body as any)?.storeId;
  if (!storeId) return;
  const store = await storeRepo.get(storeId);
  if (!store) return reply.code(404).send({ error: 'store_not_found' });
  if (!allowsAnalytics(store.planStatus)) {
    return reply.code(402).send({ error: 'payment_required', planStatus: store.planStatus });
  }
};

export async function analytics(app: FastifyInstance) {
  app.post(
    '/api/attributions/click',
    { preHandler: [requireSession, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const body = z.object({ productId: z.string().min(1) }).parse(req.body);
      const sess = (req as any).session as CustomerSession;
      const ok = await recordClick(sess.storeId, { conversationId: sess.conversationId, productId: body.productId });
      if (!ok) throw Object.assign(new Error('conversation_not_found'), { statusCode: 404 });
      return { ok: true };
    },
  );

  app.get(
    '/api/metrics/:storeId',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req, reply) => {
    const { storeId } = req.params as { storeId: string };
    const q = req.query as { days?: string };
    const days = Math.min(Math.max(Number(q.days ?? 14) || 14, 1), 90);
    const store = await storeRepo.get(storeId);
    if (!store) return reply.code(404).send({ error: 'store_not_found' });
    if (!allowsAnalytics(store.planStatus)) {
      return reply.code(402).send({ error: 'payment_required', planStatus: store.planStatus });
    }
    const daily = await getDailyMetrics(storeId, days);
    const totals = daily.reduce(
      (acc, r) => {
        acc.orders += r.orders;
        acc.revenue += r.revenue;
        acc.attributedRevenue += r.attributedRevenue;
        acc.conversations += r.conversations;
        acc.messages += r.messages;
        acc.recommended += r.recommended;
        acc.clicked += r.clicked;
        acc.converted += r.converted;
        return acc;
      },
      { orders: 0, revenue: 0, attributedRevenue: 0, conversations: 0, messages: 0, recommended: 0, clicked: 0, converted: 0 },
    );
    return { storeId, days: daily, totals };
  });

  app.get(
    '/api/analytics/:storeId/attributions',
    { preHandler: [requireApiKey, gate, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const { storeId } = req.params as { storeId: string };
      const q = req.query as { status?: string };
      const status = q.status === 'clicked' || q.status === 'converted' ? q.status : undefined;
      const rows = await attributionRows(storeId, status);
      return { storeId, count: rows.length, attributions: rows };
    },
  );

  app.get(
    '/api/analytics/:storeId/sources',
    { preHandler: [requireApiKey, gate, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const { storeId } = req.params as { storeId: string };
      const channels = await funnelByChannel(storeId);
      return { storeId, channels };
    },
  );

  app.get(
    '/api/analytics/:storeId/top-products',
    { preHandler: [requireApiKey, gate, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const { storeId } = req.params as { storeId: string };
      const q = req.query as { limit?: string };
      const limit = Math.min(Math.max(Number(q.limit ?? 10) || 10, 1), 50);
      const products = await topProducts(storeId, limit);
      return { storeId, products };
    },
  );

  app.get(
    '/api/analytics/:storeId/conversion-lag',
    { preHandler: [requireApiKey, gate, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const { storeId } = req.params as { storeId: string };
      const q = req.query as { days?: string };
      const days = Math.min(Math.max(Number(q.days ?? 14) || 14, 1), 90);
      const lag = await conversionLag(storeId, days);
      return lag;
    },
  );
}