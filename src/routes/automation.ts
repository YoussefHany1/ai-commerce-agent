import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { automationRepo } from '../db/repos.js';
import { runAllAutomation } from '../services/automation.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { requireApiKey } from '../lib/auth.js';
import { config } from '../config.js';

const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };
const actionSchema = z.object({ type: z.literal('whatsapp_text'), text: z.string().min(1) });
const createSchema = z.object({
  storeId: z.string(),
  triggerType: z.enum(['clicked_no_conversion', 'inactive_conversation']),
  action: actionSchema,
  enabled: z.boolean().optional(),
  cooldownMinutes: z.number().int().positive().max(43200).optional(),
  lookbackHours: z.number().int().positive().max(8760).optional(),
});
const updateSchema = createSchema.partial().required({ storeId: true });

export async function automation(app: FastifyInstance) {
  app.post(
    '/api/automation/rules',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const body = createSchema.parse(req.body);
      const id = await automationRepo.create(body.storeId, body);
      return { id };
    },
  );

  app.get('/api/automation/rules/:storeId', { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] }, async (req) => {
    const { storeId } = z.object({ storeId: z.string().min(1) }).parse(req.params);
    return { storeId, rules: await automationRepo.list(storeId) };
  });

  app.put(
    '/api/automation/rules/:ruleId',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const { ruleId } = z.object({ ruleId: z.string().min(1) }).parse(req.params);
      const body = updateSchema.parse(req.body);
      const ok = await automationRepo.update(body.storeId, ruleId, body);
      if (!ok) throw Object.assign(new Error('rule_not_found'), { statusCode: 404 });
      return { ok: true };
    },
  );

  app.delete(
    '/api/automation/rules/:ruleId',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const { ruleId } = z.object({ ruleId: z.string().min(1) }).parse(req.params);
      const body = z.object({ storeId: z.string() }).parse(req.body);
      const ok = await automationRepo.remove(body.storeId, ruleId);
      if (!ok) throw Object.assign(new Error('rule_not_found'), { statusCode: 404 });
      return { ok: true };
    },
  );

  app.post(
    '/api/automation/run',
    { preHandler: [requireApiKey, storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const body = z
        .object({ storeIds: z.array(z.string()).optional(), ruleIds: z.array(z.string()).optional() })
        .parse(req.body ?? {});
      const summary = await runAllAutomation({
        storeIds: body.storeIds,
        ruleIds: body.ruleIds,
        ignoreCooldown: true,
      });
      return summary;
    },
  );
}
