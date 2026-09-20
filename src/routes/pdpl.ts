import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eraseCustomer, getCustomerData, purgeStorePii } from '../services/pdpl.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { requireApiKey } from '../lib/auth.js';
import { config } from '../config.js';

const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };

const customerRefSchema = z.object({
  storeId: z.string(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
}).refine((v) => v.phone || v.email, { message: 'phone or email required' });

export async function pdpl(app: FastifyInstance) {
  app.post(
    '/api/pdpl/access',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const body = customerRefSchema.parse(req.body);
      const data = await getCustomerData(body.storeId, body);
      if (!data) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });
      return data;
    },
  );

  app.post(
    '/api/pdpl/erase',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const body = customerRefSchema.parse(req.body);
      const ok = await eraseCustomer(body.storeId, body);
      if (!ok) throw Object.assign(new Error('customer_not_found'), { statusCode: 404 });
      return { erased: true };
    },
  );

  app.post(
    '/api/pdpl/purge',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const body = z.object({ storeId: z.string() }).parse(req.body ?? {});
      const counts = await purgeStorePii(body.storeId);
      return counts;
    },
  );
}
