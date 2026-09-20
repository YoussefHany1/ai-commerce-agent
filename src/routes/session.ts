import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { storeRepo, customerRepo, conversationRepo } from '../db/repos.js';
import { requireApiKey } from '../lib/auth.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { createSession } from '../lib/session.js';
import { config } from '../config.js';

const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };

export async function session(app: FastifyInstance) {
  app.post(
    '/api/session',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const body = z
        .object({
          storeId: z.string().min(1),
          name: z.string().optional(),
          phone: z.string().optional(),
          email: z.string().optional(),
        })
        .parse(req.body);
      const store = await storeRepo.get(body.storeId);
      if (!store) throw Object.assign(new Error('store_not_found'), { statusCode: 404 });
      const customerId = await customerRepo.upsert(body.storeId, {
        name: body.name,
        phone: body.phone,
        email: body.email,
      });
      const conversationId = await conversationRepo.ensureOpen(body.storeId, customerId ?? undefined, 'web');
      const token = await createSession({ storeId: body.storeId, customerId, conversationId });
      return { token, conversationId, expiresIn: config.SESSION_TTL_SECONDS };
    },
  );
}