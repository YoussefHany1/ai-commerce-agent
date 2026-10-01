import { customerRepo, conversationRepo, whatsappRepo } from '../db/repos.js';
import { answerWithTools, toChatHistory } from './agent.js';
import { sendText } from '../integrations/whatsapp.js';
import { logger } from '../lib/logger.js';

/**
 * Inbound WhatsApp message handling, shared by both transports.
 *
 * This lives in `services/` rather than in the route module because both the Meta
 * webhook and the Baileys socket need it, and putting it in the route file would make
 * `routes/whatsapp.ts` and `services/whatsappSession.ts` import each other. That cycle
 * type-checks — both references sit inside function bodies — but it makes load order
 * load-bearing for no benefit.
 */

const MAX_TEXT_LENGTH = 2000;

/**
 * Answers one inbound text message.
 *
 * `phone` is bare digits in both transports: Meta sends it that way, and the Baileys
 * path normalises its JID before calling. Everything downstream compares phone numbers
 * as strings, so a JID here would silently lose order attribution.
 */
export async function handleInboundText(storeId: string, phone: string, text: string): Promise<void> {
  const trimmed = text.slice(0, MAX_TEXT_LENGTH);
  const customerId = await customerRepo.upsert(storeId, { phone });
  const conversationId = await conversationRepo.ensureOpen(storeId, customerId ?? undefined, 'whatsapp');
  const history = toChatHistory(await conversationRepo.history(storeId, conversationId, 10));
  await conversationRepo.addMessage({ storeId, conversationId, role: 'user', content: trimmed });

  const reply = await answerWithTools(storeId, trimmed, history);
  await conversationRepo.addMessage({ storeId, conversationId, role: 'assistant', content: reply });

  // Meta first: it is the official transport and the one a store is most likely to have
  // configured. A store paired by QR has no channel row at all, so the fallback is the
  // only path that delivers its replies.
  const channel = await whatsappRepo.byStore(storeId);
  if (channel) {
    await sendText(phone, reply, channel);
    return;
  }
  await sendOverBaileys(storeId, phone, reply);
}

/**
 * Sends over a live Baileys session when one exists.
 *
 * Imported dynamically to keep this module free of a static cycle: the session service
 * calls `handleInboundText` for inbound text, so a top-level import here would be a
 * cycle. Resolving it at call time costs nothing measurable and keeps the dependency
 * one-directional at module scope.
 */
export async function sendOverBaileys(storeId: string, phone: string, body: string): Promise<boolean> {
  try {
    const session = await import('./whatsappSession.js');
    if (!session.isLive(storeId)) return false;
    return await session.sendTextOverSocket(storeId, phone, body);
  } catch (err) {
    logger.error({ err, storeId }, 'whatsapp: baileys send path unavailable');
    return false;
  }
}