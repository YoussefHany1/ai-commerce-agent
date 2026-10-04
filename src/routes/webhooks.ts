import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { storeRepo, eventRepo } from '../db/repos.js';
import { extractEvent, verifyWebhook } from '../lib/webhooks.js';
import { applyWebhook } from '../lib/webhookApply.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
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
    const refs = event.storeRefs ?? (event.storeRef ? [event.storeRef] : []);
    let store = refs.length ? await storeRepo.byRefs(refs, p) : null;

    if (!store) {
      // Salla and Zid deliver events whose identifier field is not the one we store the
      // shop under, and the exact wrapper keys are only knowable from a live store. When
      // the platform has a single connected store there is nothing to confuse it with, so
      // attributing the event is correct rather than a guess — and with more than one,
      // guessing would write another merchant's order to the wrong store.
      const candidates = await storeRepo.listByPlatform(p);
      if (candidates.length === 1) {
        store = await storeRepo.get(candidates[0].id);
        logger.warn(
          { platform: p, storeRef: refs[0], storeRefs: refs, storeId: candidates[0].id, type: event.type },
          'webhook: store not matched by ref; attributed to the only store on this platform',
        );
      } else {
        // Name both sides so the mismatch is fixable from the log alone. `connected: 0` is
        // a different fault from a genuine ambiguity — the platform has no store at all,
        // so the install never completed or was deleted — and collapsing the two into one
        // message would send whoever reads it looking for an ambiguous multi-store account
        // that does not exist.
        const reason = candidates.length === 0 ? 'no_store_on_platform' : 'ambiguous_store';
        logger.error(
          { platform: p, storeRef: refs[0], storeRefs: refs, connected: candidates.length, type: event.type, reason },
          'store_not_found',
        );
      }
    }

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