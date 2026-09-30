import { NextResponse } from 'next/server';
import { authApiBase } from '@/lib/server/authExchange';

export const dynamic = 'force-dynamic';

/**
 * Relays an OAuth callback to the API.
 *
 * Shopify sends the browser here, so the request is a navigation with no dashboard
 * session and the query carries the credentials. It therefore cannot go through the
 * catch-all dashboard proxy, whose allowlist (`lib/server/upstream.ts`) deliberately
 * omits the oauth routes and rejects anything unauthenticated with 401 — that
 * rejection would strand the install at the last step. A dedicated route keeps the
 * allowlist narrow instead of widening it with state-changing `GET`s.
 *
 * The API authenticates this call itself: it checks the state token's HMAC-free
 * single-use Redis record and the shop HMAC. Nothing is trusted from this hop beyond
 * the query string, which is relayed verbatim.
 *
 * No `redirect: 'manual'` is set, so an upstream 302 to the post-install dashboard is
 * followed by `fetch` and the browser lands there directly.
 */
export async function GET(
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
  const upstream = new URL(`${base}/api/oauth/${platform.toLowerCase()}/callback`);
  upstream.search = incoming.search;

  let res: Response;
  try {
    res = await fetch(upstream, { cache: 'no-store' });
  } catch {
    return NextResponse.json({ error: 'oauth_callback_unreachable' }, { status: 502 });
  }

  const location = res.headers.get('location');
  if (location) return NextResponse.redirect(location, 302);

  return new Response(await res.text() || JSON.stringify({ error: 'oauth_callback_failed' }), {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}
