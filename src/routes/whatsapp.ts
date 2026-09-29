import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { customerRepo, conversationRepo, whatsappRepo } from '../db/repos.js';
import { verifyHubSignature } from '../lib/webhooks.js';
import { answerWithTools, toChatHistory } from '../services/agent.js';
import { sendText } from '../integrations/whatsapp.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { requireOperator, requireDashboard } from '../lib/auth.js';
import { logger } from '../lib/logger.js';

const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };
const MAX_TEXT_LENGTH = 2000;

export async function whatsapp(app: FastifyInstance) {
  app.get('/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const mode = q['hub.mode'];
    const token = q['hub.verify_token'];
    const challenge = q['hub.challenge'];
    if (mode === 'subscribe' && token && config.WHATSAPP_WEBHOOK_VERIFY_TOKEN && token === config.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
      return reply.code(200).send(challenge);
    }
    return reply.code(403).send('verification failed');
  });

  app.post('/webhooks/whatsapp', async (req) => {
    const raw = (req as any).rawBody as Buffer | undefined;
    if (!raw || raw.length === 0) return { received: true };
    if (!config.WHATSAPP_APP_SECRET || !verifyHubSignature(raw, req.headers as Record<string, string | string[] | undefined>, config.WHATSAPP_APP_SECRET)) {
      throw Object.assign(new Error('invalid_signature'), { statusCode: 403 });
    }
    let body: any;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw Object.assign(new Error('invalid_json'), { statusCode: 400 });
    }
    await handleWhatsappPayload(body);
    return { received: true };
  });

  app.post(
    '/api/whatsapp/channels',
    { preHandler: [requireDashboard((req) => (req.body as { storeId?: string })?.storeId, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      const body = z
        .object({
          storeId: z.string(),
          phoneNumberId: z.string().min(1),
          wabaId: z.string().optional(),
          accessToken: z.string().optional(),
        })
        .parse(req.body);
      await whatsappRepo.upsert(body);
      return { ok: true };
    },
  );

  app.get('/api/whatsapp/channels', { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] }, async () => whatsappRepo.listChannels());
}

type WhatsappChange = {
  field?: string;
  value?: {
    metadata?: { phone_number_id?: string };
    messages?: Array<{ from?: string; type?: string; text?: { body?: string } }>;
  };
};

export async function handleWhatsappPayload(payload: any): Promise<void> {
  for (const entry of payload?.entry ?? []) {
    for (const change of (entry.changes ?? []) as WhatsappChange[]) {
      if (change.field !== 'messages') continue;
      const value = change.value ?? {};
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const channel = await whatsappRepo.byPhoneNumberId(phoneNumberId);
      if (!channel) {
        logger.warn({ phoneNumberId }, 'whatsapp: no channel bound for phone_number_id');
        continue;
      }
      for (const m of value.messages ?? []) {
        if (m.type !== 'text' || !m.text?.body || !m.from) continue;
        await handleInboundText(channel.storeId, m.from, m.text.body);
      }
    }
  }
}

export async function handleInboundText(storeId: string, phone: string, text: string): Promise<void> {
  const trimmed = text.slice(0, MAX_TEXT_LENGTH);
  const customerId = await customerRepo.upsert(storeId, { phone });
  const conversationId = await conversationRepo.ensureOpen(storeId, customerId ?? undefined, 'whatsapp');
  const history = toChatHistory(await conversationRepo.history(storeId, conversationId, 10));
  await conversationRepo.addMessage({ storeId, conversationId, role: 'user', content: trimmed });

  const reply = await answerWithTools(storeId, trimmed, history);
  await conversationRepo.addMessage({ storeId, conversationId, role: 'assistant', content: reply });

  const channel = await whatsappRepo.byStore(storeId);
  if (channel) await sendText(phone, reply, channel);
}