import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { storeRepo } from '../db/repos.js';
import type { Store } from '../db/schema.js';
import { config } from '../config.js';

/**
 * Storefront widget embedding.
 *
 * The widget runs on the merchant's storefront — a third-party origin, in someone
 * else's browser — so it can hold neither the admin key nor the store API key. What
 * it holds instead is an *embed key*: a public identifier, safe to read out of the
 * page source, that authorises exactly one thing, minting a customer session for
 * its own store.
 *
 * That is a deliberately small blast radius. A customer session is accepted by two
 * routes and no others (`POST /api/chat`, `POST /api/attributions/click`), so the
 * worst a leaked key can do is spend the merchant's AI budget and pollute their own
 * funnel. Two things bound that, and both are load-bearing:
 *
 *   1. Origin binding. A request is only honoured when its `Origin` is one the
 *      store itself is allowed to be embedded on. Without it, any site on the
 *      internet could paste the key in and talk to the API as this merchant.
 *   2. Per-IP rate limits on the session mint, which is the expensive endpoint.
 *
 * Neither is a substitute for the other: the key is public, so the origin check is
 * the only thing distinguishing the merchant's storefront from an impersonator.
 */

/** 32 hex chars of entropy, prefixed so it is greppable in a merchant's source. */
export const EMBED_KEY_PATTERN = /^aca_pub_[0-9a-f]{32}$/;

export const EMBED_KEY_HEADER = 'x-embed-key';

export function generateEmbedKey(): string {
  return `aca_pub_${randomBytes(16).toString('hex')}`;
}

export function readEmbedKey(req: FastifyRequest): string | undefined {
  const raw = req.headers[EMBED_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * Origins this store's widget may be embedded on.
 *
 * The shop domain is the floor: it is the address the platform itself gave us, and
 * for a Shopify install it is the origin the merchant's customers actually visit.
 * A merchant on a custom domain adds it to `settings.widgetOrigins`, because we
 * cannot infer it — and guessing would mean trusting a header, which is the one
 * thing an origin check must never do.
 *
 * Ports are ignored: a merchant previewing on `:3000` is still the same site, and
 * the port is not part of the trust decision.
 */
export function allowedWidgetOrigins(store: Pick<Store, 'shopDomain' | 'settings'>): string[] {
  const out = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== 'string') return;
    const host = raw.trim().toLowerCase();
    if (!host) return;
    out.add(host.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, ''));
  };

  add(store.shopDomain);
  const configured = (store.settings as { widgetOrigins?: unknown } | null)?.widgetOrigins;
  if (Array.isArray(configured)) configured.forEach(add);

  return [...out].filter(Boolean);
}

/**
 * Whether `origin` is one this store may be embedded on.
 *
 * A missing Origin is accepted: same-origin and non-browser clients send none, and
 * the widget's own endpoints are already bounded by the embed key and rate limits.
 * A *present but unlisted* Origin is refused, which is the case that matters.
 */
export function originAllowed(origin: string | undefined, store: Pick<Store, 'shopDomain' | 'settings'>): boolean {
  if (!origin) return true;
  let host: string;
  try {
    // `host` includes the port, `hostname` does not. The allowlist is port-free
    // (see allowedWidgetOrigins), so the comparison has to be too — otherwise a
    // merchant previewing on :3000 is refused even though their shop domain is right.
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedWidgetOrigins(store).includes(host);
}

/**
 * Resolves the embed key to a store, refusing a cross-origin request.
 *
 * Replies 401 for an unknown or malformed key and 403 for a disallowed origin —
 * both before any handler runs, so a rejected embed never reaches the AI path.
 */
export async function requireEmbedKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = readEmbedKey(req);
  if (!key || !EMBED_KEY_PATTERN.test(key)) {
    reply.code(401).send({ error: 'invalid_embed_key' });
    return;
  }
  const store = await storeRepo.getByEmbedKey(key).catch(() => null);
  if (!store) {
    reply.code(401).send({ error: 'invalid_embed_key' });
    return;
  }
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!originAllowed(origin, store)) {
    reply.code(403).send({ error: 'origin_not_allowed' });
    return;
  }
  (req as any).embedStore = store;
}

/**
 * Routes the storefront widget calls cross-origin.
 *
 * `/api/chat` and `/api/attributions/click` are ordinary session-authenticated
 * routes used by the dashboard too; they are listed because the widget reaches them
 * from the merchant's origin and needs the same CORS grant.
 */
const WIDGET_CORS_PATHS = new Set(['/api/widget/session', '/api/chat', '/api/attributions/click']);

/** True when the global CORS config already covers this origin. */
function globallyAllowed(origin: string): boolean {
  const configured = config.CORS_ORIGINS
    ? config.CORS_ORIGINS === '*'
      ? true
      : config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : config.APP_BASE_URL;
  if (configured === true) return true;
  return (Array.isArray(configured) ? configured : [configured]).some((o) => o === origin);
}

/**
 * CORS for the widget, resolved per store.
 *
 * Registered *before* `@fastify/cors` so it sees the preflight first: a browser
 * sends `OPTIONS` with no body, so the embed key has to travel in the header (it
 * does — the widget sends it on every call), and this hook has to be the one that
 * answers the preflight rather than the global handler, which would reject an
 * origin it has never heard of.
 *
 * It only does work for a request that actually needs it: no `Origin`, a
 * globally-allowed origin, or a non-widget path all return immediately, so this
 * costs nothing on the dashboard's own traffic.
 */
export function widgetCorsHook(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!origin) return;
    if (globallyAllowed(origin)) return;

    const path = (req.url ?? '').split('?')[0]!;
    if (!WIDGET_CORS_PATHS.has(path)) return;

    const key = readEmbedKey(req);
    if (!key || !EMBED_KEY_PATTERN.test(key)) return;

    const store = await storeRepo.getByEmbedKey(key).catch(() => null);
    if (!store || !originAllowed(origin, store)) return;

    reply.header('access-control-allow-origin', origin);
    reply.header('vary', 'Origin');
    reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    reply.header('access-control-allow-headers', `Content-Type, Authorization, ${EMBED_KEY_HEADER}`);
    reply.header('access-control-max-age', '600');

    if (req.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  });
}
