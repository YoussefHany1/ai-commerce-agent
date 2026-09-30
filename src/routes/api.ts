import { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  storeRepo,
  catalogRepo,
  conversationRepo,
  storeToPublic,
  jobsRepo,
} from '../db/repos.js';
import { getCommerceAdapter, verifyStoreCredentials } from '../integrations/factory.js';
import { recordImpressions } from '../services/analytics.js';
import { answerWithTools, toChatHistory } from '../services/agent.js';
import { retrieve, embedMissingCatalog } from '../services/retrieval.js';
import { dbPing, redisPing, rlsPing } from '../lib/health.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { requireOperator, requireDashboard, sha256Hex, type Principal } from '../lib/auth.js';
import { requireSession, type CustomerSession } from '../lib/session.js';
import { generateEmbedKey } from '../lib/widget.js';
import { config } from '../config.js';

const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };

/** Actionable text per verification failure, keyed by the factory's `reason`. */
const CREDENTIAL_FAILURE_MESSAGE = {
  missing_shop_domain: 'Enter the shop domain, for example shop.myshopify.com.',
  zid_requires_oauth: 'Zid stores can only be connected through the Zid OAuth flow.',
  unreachable: 'Could not verify those credentials with the platform. Check the shop domain and that the token is valid.',
} as const;
const chatWindow = { limit: config.RATE_LIMIT_CHAT_PER_MIN, windowSec: 60 };
const storeIdParam = z.object({ storeId: z.string().min(1) });

export async function api(app: FastifyInstance) {
  app.get('/api/health', async (_req, reply) => {
    const [dbOk, redisOk, rlsOk] = await Promise.all([dbPing(), redisPing(), rlsPing()]);
    const deps = { db: dbOk, redis: redisOk, rls: rlsOk };
    // A degraded RLS layer is a 503, not a footnote in the body. Reporting it
    // alongside a 200 status is what let an owner connection that ignored every
    // tenant policy look healthy; Dockerfile's HEALTHCHECK keys off this status,
    // so failing here takes the container out of rotation instead.
    if (!dbOk || !redisOk || !rlsOk) {
      return reply.code(503).send({ status: 'error', ...deps, time: new Date().toISOString() });
    }
    return {
      status: 'ok',
      db: 'connected',
      ok: true,
      deps,
      uptime: process.uptime(),
      time: new Date().toISOString(),
    };
  });

  app.get(
    '/api/stores',
    { preHandler: [requireDashboard(), storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
    const principal = (req as any).principal as Principal;
    // A client sees only its own stores (RLS-scoped); the operator sees all.
    const rows = principal.kind === 'client' ? await storeRepo.listForClient(principal.clientId) : await storeRepo.list();
    return rows.map(storeToPublic);
  });

  app.post(
    '/api/stores',
    { preHandler: [requireDashboard(), storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
    const body = z
      .object({
        name: z.string().min(1),
        platform: z.enum(['shopify', 'salla', 'zid']),
        shopDomain: z.string().optional(),
        accessToken: z.string().min(1, 'An access token is required to connect a store'),
      })
      .parse(req.body);

    // Manual duplicate guard: (platform, shop_domain) has no DB unique index.
    if (body.shopDomain) {
      const existing = await storeRepo.findByPlatformAndDomain(body.platform, body.shopDomain);
      if (existing) return rep.code(409).send({ error: 'store_already_exists' });
    }

    // Prove the credentials work *before* the row exists. A store written with an
    // unusable or absent token can never build a commerce adapter, so every
    // `catalog.sync` and `order.sync` job for it dies with `no_connection` and the
    // dashboard shows an empty funnel with nothing in the console to explain why.
    // Rejecting here turns that silent dead store into an actionable 422.
    const check = await verifyStoreCredentials({
      platform: body.platform,
      shopDomain: body.shopDomain,
      accessToken: body.accessToken,
    });
    if (!check.ok) {
      return rep.code(422).send({
        error: 'invalid_store_credentials',
        reason: check.code,
        // The dashboard toasts `message` verbatim, so it has to be something the
        // merchant can act on. The platform's own text (a raw 401, or a GraphQL
        // error blob) goes in `detail` for the logs instead of in their face.
        message: CREDENTIAL_FAILURE_MESSAGE[check.code],
        detail: check.message,
      });
    }

    const principal = (req as any).principal as Principal;
    // A client creates its store inside its own scope, so the WITH CHECK clause on
    // tenant_client_stores proves the row is being scoped to the caller.
    const id =
      principal.kind === 'client'
        ? await storeRepo.create({ ...body, clientId: principal.clientId })
        : await storeRepo.create(body);

    // Manually added stores never went through saveInstall, so they miss the
    // install-time kick. Enqueue the order backfill here too, otherwise a store
    // added from the dashboard sits on zero revenue until the next 15-minute
    // orderSync tick notices its null cursor. The catalog is kicked for the same
    // reason: without it the agent has an empty catalog and cannot recommend
    // anything, so every analytics card stays empty until the next hourly tick.
    // Both are best-effort — the store is already connected, and the periodic
    // tick would eventually pick the work up regardless.
    for (const type of ['order.sync', 'catalog.sync'] as const) {
      try {
        await jobsRepo.enqueue(id, type, {}, { runAt: new Date() });
      } catch (err) {
        app.log.warn({ err, storeId: id, type }, `${type} enqueue failed for new store`);
      }
    }

    return { id };
  });

  app.delete(
    '/api/stores/:storeId',
    { preHandler: [requireDashboard((req) => (req.params as { storeId?: string }).storeId), storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { storeId } = storeIdParam.parse(req.params);
      const store = await storeRepo.get(storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      await storeRepo.remove(storeId);
      return { ok: true };
    },
  );

  app.post(
    '/api/stores/:storeId/keys',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { storeId } = storeIdParam.parse(req.params);
      const store = await storeRepo.get(storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      const key = `sk_live_${randomBytes(32).toString('hex')}`;
      await storeRepo.setApiKey(storeId, sha256Hex(key), key.slice(-4));
      return { storeId, key, apiKeyHint: key.slice(-4) };
    },
  );

  app.get(
    '/api/stores/:storeId/keys',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { storeId } = storeIdParam.parse(req.params);
      const store = await storeRepo.get(storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      return { storeId, apiKeyHint: await storeRepo.getApiKeyHint(storeId) };
    },
  );

  app.delete(
    '/api/stores/:storeId/keys',
    { preHandler: [requireOperator, storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { storeId } = storeIdParam.parse(req.params);
      const store = await storeRepo.get(storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      await storeRepo.clearApiKey(storeId);
      return { ok: true };
    },
  );

  /**
   * The widget's embed key.
   *
   * Readable by anyone who owns the store, not just the operator: the merchant is
   * the one who has to paste it into their storefront, so making it operator-only
   * would mean an operator acting as a helpdesk for every install. `requireDashboard`
   * with a storeIdRef proves ownership and 404s a store that is not theirs, so this
   * cannot be used to probe for other stores' keys.
   */
  app.get(
    '/api/stores/:storeId/embed-key',
    { preHandler: [requireDashboard((req) => (req.params as { storeId?: string }).storeId), storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { storeId } = storeIdParam.parse(req.params);
      const store = await storeRepo.get(storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      return { storeId, embedKey: store.embedKey ?? null };
    },
  );

  /**
   * Mints the key if absent, and rotates on demand.
   *
   * Rotation is the revoke path for a key that leaked — a merchant who pasted it
   * somewhere they no longer controls can invalidate it without an operator. The
   * old key stops resolving immediately, which also stops the storefront widget
   * from minting sessions, so the widget degrades rather than silently persisting.
   */
  app.post(
    '/api/stores/:storeId/embed-key',
    { preHandler: [requireDashboard((req) => (req.params as { storeId?: string }).storeId), storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { storeId } = storeIdParam.parse(req.params);
      const store = await storeRepo.get(storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      const { rotate } = z.object({ rotate: z.boolean().optional() }).parse(req.body ?? {});
      if (store.embedKey && !rotate) return { storeId, embedKey: store.embedKey, created: false };
      const embedKey = generateEmbedKey();
      await storeRepo.setEmbedKey(storeId, embedKey);
      return { storeId, embedKey, created: true };
    },
  );

  app.get(
    '/api/products/:storeId',
    { preHandler: [requireDashboard((req) => (req.params as { storeId?: string }).storeId, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
    async (req, rep) => {
      const { storeId } = storeIdParam.parse(req.params);
      const store = await storeRepo.get(storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      let list = await catalogRepo.list(storeId);
      const adapter = await getCommerceAdapter(storeId);
      if (adapter) {
        list = await adapter.listProducts();
        await catalogRepo.upsert(storeId, list, (await catalogRepo.syncVersion(storeId)) + 1);
        await catalogRepo.markSynced(storeId);
      }
      await embedMissingCatalog(storeId);
      return list;
    },
  );

  app.post(
    '/api/chat',
    { preHandler: [requireSession, storeRateLimitWindow('chat', chatWindow)] },
    async (req, rep) => {
      const body = z.object({ message: z.string().min(1).max(2000) }).parse(req.body);
      const sess = (req as any).session as CustomerSession;
      const store = await storeRepo.get(sess.storeId);
      if (!store) return rep.code(404).send({ error: 'store_not_found' });
      const found = await retrieve(body.message, sess.storeId);
      const list = found.map((f) => f.product);
      const conversationId = sess.conversationId;
      const history = toChatHistory(await conversationRepo.history(sess.storeId, conversationId, 10));
      await conversationRepo.addMessage({ storeId: sess.storeId, conversationId, role: 'user', content: body.message });
      const reply = await answerWithTools(sess.storeId, body.message, history);
      await conversationRepo.addMessage({ storeId: sess.storeId, conversationId, role: 'assistant', content: reply });
      // Record the recommendation before returning it, so the funnel has a
      // denominator even for a product the shopper never clicks. Best-effort: a
      // failed analytics write must not cost the shopper their answer.
      await recordImpressions(sess.storeId, {
        conversationId,
        productIds: list.map((p) => p.id),
      }).catch(() => 0);
      return { reply, products: list };
    },
  );
}