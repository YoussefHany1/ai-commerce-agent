import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { customerRepo, conversationRepo } from '../db/repos.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { requireEmbedKey } from '../lib/widget.js';
import { createSession } from '../lib/session.js';
import { config } from '../config.js';
import type { Store } from '../db/schema.js';

/**
 * The storefront widget's entry point.
 *
 * Deliberately one route. The widget needs a customer session to call `/api/chat`
 * and `/api/attributions/click`, and it cannot get one any other way without a
 * credential it must not have. Everything it is allowed to do follows from the
 * session it is handed here.
 */
export async function widget(app: FastifyInstance) {
  // A tighter bucket than the dashboard's `api` window: this is the endpoint that
  // spends money, it is reachable with a public key, and each call can start a
  // fresh conversation. Rate limiting is the real control on AI spend here.
  const sessionWindow = { limit: Math.max(10, Math.floor(config.RATE_LIMIT_PER_MIN / 4)), windowSec: 60 };

  app.post(
    '/api/widget/session',
    { preHandler: [requireEmbedKey, storeRateLimitWindow('widget', sessionWindow)] },
    async (req) => {
      const body = z
        .object({
          // Captured so a later order can be matched back to this conversation.
          // Without a phone or email on the customer there is nothing for
          // `markConversionsForOrder` to join on, and the click never becomes a
          // conversion — which is the whole point of the attribution.
          name: z.string().max(200).optional(),
          email: z.string().email().max(320).optional(),
          phone: z.string().min(5).max(40).optional(),
        })
        .parse(req.body ?? {});
      const store = (req as any).embedStore as Store;

      const customerId = await customerRepo.upsert(store.id, {
        name: body.name,
        phone: body.phone,
        email: body.email,
      });
      const conversationId = await conversationRepo.ensureOpen(store.id, customerId ?? undefined, 'web');
      const token = await createSession({ storeId: store.id, customerId, conversationId });
      return { token, conversationId, expiresIn: config.SESSION_TTL_SECONDS };
    },
  );
}
