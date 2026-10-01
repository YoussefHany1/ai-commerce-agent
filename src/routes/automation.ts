import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { automationRepo, storeRepo } from '../db/repos.js';
import { runAllAutomation } from '../services/automation.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { requireOperator, requireDashboard } from '../lib/auth.js';
import { config } from '../config.js';

const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };
const storeIdRef = (req: any) =>
  ((req as any).params as { storeId?: string })?.storeId ?? ((req as any).body as { storeId?: string })?.storeId;

const text = z.string().min(1).max(4000);
const phone = z
  .string()
  .min(5)
  .max(24)
  .transform((v) => v.replace(/\D/g, ''))
  .refine((v) => v.length >= 8 && v.length <= 15, 'invalid_phone');

const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('whatsapp_text'), text }),
  z.object({ type: z.literal('whatsapp_number'), phone, text }),
  z.object({ type: z.literal('template'), templateId: z.string().min(1).max(64), text }),
]);

const triggerConfigSchema = z.object({
  keywords: z.array(z.string().min(1).max(60)).max(50).optional(),
});

const templateSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  text: z.string().min(1).max(4000),
});

const createSchema = z.object({
  storeId: z.string(),
  triggerType: z.enum(['clicked_no_conversion', 'inactive_conversation', 'keyword', 'new_conversation', 'order_placed']),
  triggerConfig: triggerConfigSchema.optional(),
  action: actionSchema,
  enabled: z.boolean().optional(),
  cooldownMinutes: z.number().int().positive().max(43200).optional(),
  lookbackHours: z.number().int().positive().max(8760).optional(),
});
const updateSchema = createSchema.partial().required({ storeId: true });

/**
 * A keyword rule with no keywords would otherwise be a rule that never fires, which
 * reads as a bug rather than as configuration. Reject it at the edge instead.
 *
 * Kept out of the zod object because `.partial()` is used for updates and is not
 * available on a schema carrying a `.refine`.
 */
function assertTrigger(body: { triggerType?: string; triggerConfig?: { keywords?: string[] } }): void {
  if (body.triggerType !== 'keyword') return;
  const keywords = body.triggerConfig?.keywords ?? [];
  if (!keywords.length) throw Object.assign(new Error('keyword_required'), { statusCode: 400 });
}

export async function automation(app: FastifyInstance) {
  app.post(
    '/api/automation/rules',
    { preHandler: [requireDashboard(storeIdRef, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const body = createSchema.parse(req.body);
      assertTrigger(body);
      const id = await automationRepo.create(body.storeId, body);
      return { id };
    },
  );

  app.get(
    '/api/automation/templates/:storeId',
    { preHandler: [requireDashboard(storeIdRef, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const { storeId } = z.object({ storeId: z.string().min(1) }).parse(req.params);
      return { storeId, templates: await storeRepo.getMessageTemplates(storeId) };
    },
  );

  app.put(
    '/api/automation/templates/:storeId',
    { preHandler: [requireDashboard(storeIdRef, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const { storeId } = z.object({ storeId: z.string().min(1) }).parse(req.params);
      const body = z.object({ templates: z.array(templateSchema).max(50) }).parse(req.body);
      await storeRepo.setMessageTemplates(storeId, body.templates);
      return { ok: true };
    },
  );

  app.get('/api/automation/rules/:storeId', { preHandler: [requireDashboard(storeIdRef, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] }, async (req) => {
    const { storeId } = z.object({ storeId: z.string().min(1) }).parse(req.params);
    return { storeId, rules: await automationRepo.list(storeId) };
  });

  app.put(
    '/api/automation/rules/:ruleId',
    { preHandler: [requireDashboard(storeIdRef, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const { ruleId } = z.object({ ruleId: z.string().min(1) }).parse(req.params);
      const body = updateSchema.parse(req.body);
      assertTrigger(body);
      const ok = await automationRepo.update(body.storeId, ruleId, body);
      if (!ok) throw Object.assign(new Error('rule_not_found'), { statusCode: 404 });
      return { ok: true };
    },
  );

  app.delete(
    '/api/automation/rules/:ruleId',
    { preHandler: [requireDashboard(storeIdRef, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
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
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
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
