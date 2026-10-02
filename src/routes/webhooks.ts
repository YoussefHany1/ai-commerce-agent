import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { storeRepo, eventRepo } from '../db/repos.js';
import { extractEvent, verifyWebhook } from '../lib/webhooks.js';
import { applyWebhook } from '../lib/webhookApply.js';
import { config } from '../config.js';
import type { Platform } from '../types.js';

const PLATFORMS = ['shopify', 'salla', 'zid'] as const;

export async function webhooks(app: FastifyInstance) {
  app.post('/webhooks/:platform', async (req) => {
    const { platform } = z.object({ platform: z.string() }).parse(req.params);
    if (!(PLATFORMS as readonly string[]).includes(platform)) {
      throw Object.assign(new Error('unknown_platform'), { statusCode: 400 });
    }
    const raw = (req as any).rawBody as Buffer | undefined;
    if (!raw || raw.length === 0) throw Object.assign(new Error('missing_body'), { statusCode: 400 });

    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw Object.assign(new Error('invalid_json'), { statusCode: 400 });
    }

    const p = platform as Platform;
    if (!verifyWebhook(p, raw, req.headers as Record<string, string | string[] | undefined>)) {
      throw Object.assign(new Error('invalid_signature'), { statusCode: 401 });
    }

    const event = extractEvent(p, raw, req.headers as Record<string, string | string[] | undefined>, body);
    const store = event.storeRef ? await storeRepo.byRef(event.storeRef, p) : null;
    if (!store) {
      // An uninstall whose store is already gone is the desired end state, so answer 2xx.
      // Returning 404 made Shopify retry the same uninstall several times against a store
      // that no longer existed — every retry failed identically, so nothing changed except
      // noise in the logs and delivery attempts against a dead shop.
      if (event.type === 'app/uninstalled') return { received: true, alreadyRemoved: true };
      throw Object.assign(new Error('store_not_found'), { statusCode: 404 });
    }

    const recorded = await eventRepo.record({
      storeId: store.id,
      type: event.type,
      dedupKey: event.dedupKey,
      payload: event.payload,
    });
    if (!recorded) return { received: true, duplicate: true };

    await applyWebhook(p, event, store.id);
    return { received: true };
  });
}

export async function registerRawBody(app: FastifyInstance) {
  const { Readable } = await import('node:stream');
  app.addHook('preParsing', async (request, _reply, payload) => {
    if (!request.url.startsWith('/webhooks')) return payload;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of payload) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > config.WEBHOOK_BODY_LIMIT) {
        payload.destroy();
        throw Object.assign(new Error('payload_too_large'), { statusCode: 413 });
      }
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks);
    (request as any).rawBody = raw;
    return Readable.from([raw]);
  });
}