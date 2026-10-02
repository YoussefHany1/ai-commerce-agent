import { NextResponse } from 'next/server';
import { authApiBase } from '@/lib/server/authExchange';

export const dynamic = 'force-dynamic';

/**
 * Relays a platform webhook to the API.
 *
 * Needed because the public tunnel fronts this app (port 3001) so the embedded admin
 * UI loads, while Shopify delivers webhooks to `APP_BASE_URL` — the same origin. With
 * no Next route at `/webhooks/*` those requests 404 and the app silently stops
 * receiving orders. This route is deliberately not a `next.config` rewrite: a rewrite
 * would hand the body to a proxy layer with no guarantee of preserving it byte for
 * byte, and Shopify signs the raw payload, so any re-serialisation of the JSON would
 * break HMAC verification and the event would be rejected.
 *
 * `await request.text()` gives the exact bytes, and the same string is forwarded with
 * the original content type, so Fastify re-derives an identical raw body and the API's
 * own HMAC check still passes.
 *
 * This path is intentionally outside the dashboard proxy's allowlist (`lib/server/
 * upstream.ts`): a webhook is authenticated by the platform's signature, not by a
 * session, and is never called from the browser.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ platform: string }> },
): Promise<Response> {
  const base = authApiBase();
  if (!base) return NextResponse.json({ error: 'upstream_not_configured' }, { status: 503 });

  const { platform } = await ctx.params;
  if (!/^[a-z]+$/i.test(platform)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const incoming = new URL(request.url);
  const upstream = new URL(`${base}/webhooks/${platform.toLowerCase()}`);
  upstream.search = incoming.search;

  // Verbatim, and forwarded without a session credential: the platform's HMAC is the
  // authenticator, so attaching a dashboard session would only widen what is trusted.
  const body = await request.text();
  const headers: Record<string, string> = { 'content-type': request.headers.get('content-type') ?? 'application/json' };

  // The HMAC alone says "this payload is authentic", not "what happened" or "for which
  // store". The API reads `x-shopify-topic` for the event type and `x-shopify-shop-domain`
  // to resolve the store, and 404s on `store_not_found` when the domain header is absent.
  // Relaying only the signature therefore made every webhook an unknown-topic event for
  // no store: order sync stopped updating live, and `app/uninstalled` never reached its
  // handler, so a store the merchant had deleted in Shopify still showed as connected in
  // the dashboard. Forward the whole identifying set, plus Salla's equivalent header.
  const forwarded = [
    'x-shopify-hmac-sha256',
    'x-shopify-topic',
    'x-shopify-shop-domain',
    'x-shopify-webhook-id',
    'x-shopify-triggered-at',
    'x-shopify-api-version',
    'x-hub-signature-256',
    'x-hub-signature',
  ];
  for (const name of forwarded) {
    const v = request.headers.get(name);
    if (v) headers[name] = v;
  }

  try {
    const res = await fetch(upstream, { method: 'POST', headers, body, cache: 'no-store' });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    });
  } catch {
    return NextResponse.json({ error: 'upstream_unreachable' }, { status: 502 });
  }
}

/**
 * Shopify (and Salla) probe for reachability with a HEAD/GET before delivering, and
 * answer it themselves. Answer locally rather than forwarding: an unauthenticated
 * probe must not be relayed to a handler that expects a signed payload.
 */
export async function GET(): Promise<Response> {
  return NextResponse.json({ ok: true });
}
