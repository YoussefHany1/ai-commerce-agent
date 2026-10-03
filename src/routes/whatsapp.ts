import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { baileysSessionRepo, storeRepo, whatsappRepo } from '../db/repos.js';
import { verifyHubSignature } from '../lib/webhooks.js';
import { handleInboundText } from '../services/whatsappInbound.js';
import { storeRateLimitWindow } from '../lib/rateLimit.js';
import { requireOperator, requireDashboard } from '../lib/auth.js';
import { logger } from '../lib/logger.js';
import {
  SessionBusyError,
  SessionLimitError,
  livePhone,
  qrFor,
  startSession,
  statusFor,
  stopSession,
  subscribe,
} from '../services/whatsappSession.js';

const apiWindow = { limit: config.RATE_LIMIT_PER_MIN, windowSec: 60 };

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
    // Ack Meta before doing the work. Processing runs the agent and sends the
    // reply, which routinely outlasts Meta's webhook timeout — and a timeout makes
    // Meta redeliver the same message, so the customer would get duplicate replies.
    // Signature and JSON are already validated above, so a 200 here is honest.
    void handleWhatsappPayload(body).catch((err) =>
      logger.error({ err }, 'whatsapp: webhook processing failed'),
    );
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

  registerQrRoutes(app);
}

/**
 * The unofficial-protocol warning, shown before the merchant reaches the pairing flow.
 *
 * Deliberately not a checkbox inside the card: the merchant is the party whose number
 * gets banned, and a box inside a card they are already scanning past is not informed
 * consent. It gates access, and §1.3 of the plan puts it ahead of pairing.
 */
const TOS_SUMMARY = [
  'Pairing uses WhatsApp Web, an unofficial protocol that Meta does not support.',
  'Meta can temporarily or permanently ban a number used this way.',
  'Reconnecting frequently is a known trigger for that action.',
  'Use a number you can afford to lose, and prefer the official Cloud API where you can.',
].join(' ');

/**
 * Whether this store has accepted the *current* terms version.
 *
 * Versioned rather than a bare boolean so revising the wording re-prompts every
 * merchant instead of leaving a stale acceptance standing forever.
 */
export function hasAcknowledgedTos(store: { settings: unknown } | null | undefined): boolean {
  const ack = (store?.settings as { whatsappQrAcknowledged?: { version?: string } } | null | undefined)
    ?.whatsappQrAcknowledged;
  return ack?.version === config.WHATSAPP_BAILEYS_TOS_VERSION;
}

/**
 * QR pairing routes.
 *
 * All four 404 when `WHATSAPP_BAILEYS_ENABLED` is off, rather than 403: the feature is
 * not part of this deployment at all, and a 403 invites a retry loop against an endpoint
 * that will never succeed.
 *
 * The ToS gate lives on `qr-connect` specifically — it is the route that mints a
 * session, so a client that skips the interstitial still cannot obtain a number. The
 * read-only routes stay open so the dashboard can render "unavailable" from real state
 * instead of guessing.
 */
function registerQrRoutes(app: FastifyInstance): void {
  const dashboard = (req: any) => (req.body as { storeId?: string })?.storeId ?? (req.query as { storeId?: string })?.storeId;

  app.post(
    '/api/whatsapp/qr-connect',
    {
      preHandler: [
        requireDashboard(dashboard, { allowStoreKey: true }),
        storeRateLimitWindow('api', apiWindow),
      ],
    },
    async (req, reply) => {
      if (!config.whatsappBaileysEnabled) return reply.code(404).send({ error: 'not_available' });
      const { storeId } = z.object({ storeId: z.string() }).parse(req.body);

      // Gate before any socket work: this is the control, the UI is the courtesy.
      const store = await storeRepo.get(storeId);
      if (!hasAcknowledgedTos(store)) {
        return reply.code(403).send({
          error: 'tos_not_acknowledged',
          message: TOS_SUMMARY,
          version: config.WHATSAPP_BAILEYS_TOS_VERSION,
        });
      }

      try {
        const { resumed } = await startSession(storeId);
        return { ok: true, resumed };
      } catch (err) {
        if (err instanceof SessionLimitError) {
          return reply.code(409).send({
            error: 'session_limit_reached',
            openSessions: err.openSessions,
            maxSessions: config.WHATSAPP_BAILEYS_MAX_SESSIONS,
          });
        }
        // Another replica owns this number. Not an error worth surfacing as a 500.
        if (err instanceof SessionBusyError) {
          return reply.code(409).send({ error: 'session_busy' });
        }
        throw err;
      }
    },
  );

  /**
   * Records the warning acceptance.
   *
   * Separate from `qr-connect` so the interstitial can persist consent without opening
   * a socket: the merchant reads the terms, dismisses the card, and only then pairs.
   */
  app.post(
    '/api/whatsapp/qr-acknowledge',
    { preHandler: [requireDashboard(dashboard, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      if (!config.whatsappBaileysEnabled) throw Object.assign(new Error('not_available'), { statusCode: 404 });
      const { storeId } = z.object({ storeId: z.string() }).parse(req.body);
      await storeRepo.updateSettings(storeId, {
        whatsappQrAcknowledged: { version: config.WHATSAPP_BAILEYS_TOS_VERSION, at: new Date().toISOString() },
      });
      return { ok: true, version: config.WHATSAPP_BAILEYS_TOS_VERSION };
    },
  );

  app.get(
    '/api/whatsapp/qr-status',
    { preHandler: [requireDashboard((req) => (req.query as { storeId?: string })?.storeId, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      if (!config.whatsappBaileysEnabled) throw Object.assign(new Error('not_available'), { statusCode: 404 });
      const { storeId } = z.object({ storeId: z.string() }).parse(req.query);
      const [store, row] = await Promise.all([storeRepo.get(storeId), baileysSessionRepo.get(storeId)]);
      return {
        enabled: true,
        tosAcknowledged: hasAcknowledgedTos(store),
        tosVersion: config.WHATSAPP_BAILEYS_TOS_VERSION,
        status: statusFor(storeId) ?? row?.status ?? 'idle',
        phone: livePhone(storeId) ?? row?.phone ?? null,
        lastError: row?.lastError ?? null,
        maxSessions: config.WHATSAPP_BAILEYS_MAX_SESSIONS,
      };
    },
  );

  /**
   * Server-sent events for the pairing flow.
   *
   * SSE rather than polling because a QR rotates every ~20s: polling that fast from
   * every open dashboard tab is a self-inflicted load problem, and the stream also
   * carries the `open` / `replaced` transitions a poll would still miss.
   *
   * Subscriptions are per store, so one tenant's events can never reach another's.
   */
  app.get(
    '/api/whatsapp/qr-stream',
    { preHandler: [requireDashboard((req) => (req.query as { storeId?: string })?.storeId, { allowStoreKey: true })] },
    async (req, reply) => {
      if (!config.whatsappBaileysEnabled) return reply.code(404).send({ error: 'not_available' });
      const { storeId } = z.object({ storeId: z.string() }).parse(req.query);

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Proxies that buffer would defeat the point of a stream.
        'x-accel-buffering': 'no',
      });

      const send = (data: unknown): void => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      send({ type: 'status', status: statusFor(storeId) ?? 'idle' });
      // Replay the current QR, if any: it is emitted once and rotates only every ~20s, so
      // a subscriber that connects a beat late would otherwise stare at an empty box.
      const qr = qrFor(storeId);
      if (qr) send({ type: 'qr', qr });
      const unsubscribe = subscribe(storeId, send);

      // Keeps intermediaries from closing an idle connection during a long pairing wait.
      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
      heartbeat.unref?.();

      req.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
  );

  app.delete(
    '/api/whatsapp/qr-disconnect',
    { preHandler: [requireDashboard(dashboard, { allowStoreKey: true }), storeRateLimitWindow('api', apiWindow)] },
    async (req) => {
      if (!config.whatsappBaileysEnabled) throw Object.assign(new Error('not_available'), { statusCode: 404 });
      const { storeId } = z.object({ storeId: z.string() }).parse(req.body);
      // logout, not end: the merchant asked to disconnect, so the number is unlinked.
      await stopSession(storeId, { logout: true });
      return { ok: true };
    },
  );
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

export { handleInboundText };