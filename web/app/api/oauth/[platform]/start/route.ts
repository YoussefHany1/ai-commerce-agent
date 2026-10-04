import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/server/session';
import { buildUpstreamHeaders, type UpstreamPrincipal } from '@/lib/server/upstream';
import { authApiBase } from '@/lib/server/authExchange';

export const dynamic = 'force-dynamic';

/**
 * The platforms with a merchant-initiated OAuth install. Anything else is a 404 rather
 * than a pass-through: the API has no start route for it, and relaying an arbitrary
 * segment would turn this into an open proxy onto the API's namespace.
 */
const INSTALLABLE = ['shopify', 'salla', 'zid'] as const;

/**
 * Proxies the OAuth *start* endpoint so it runs same-origin and can carry the caller's
 * session.
 *
 * Following an install link straight at the API is a cross-origin navigation, so the
 * BFF's session cookie is never attached and the API cannot tell who asked. That is
 * precisely why OAuth installs were operator-only. Routing the start through this app
 * lets the proxy forward the verified session in `x-client-session` or
 * `x-operator-session`, and the API records the resolved tenant in the server-side
 * OAuth state.
 *
 * The 302 to the platform is passed through untouched and the browser follows it. No
 * credential is ever placed in the redirect URL: identity travels only in the opaque
 * state token, which the API keeps in Redis and which never reaches the browser.
 *
 * One route for all three platforms, mirroring the `[platform]/callback` relay beside it.
 * Shopify had the only start proxy, which left Salla and Zid with an install flow the API
 * fully implemented but no way to reach from a browser — a merchant opening
 * `/api/oauth/salla/start` on the dashboard origin got a 404, and the only working entry
 * point was typing the API's own URL, which drops the session and installs the store as
 * operator-owned that the signed-in client then cannot see.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ platform: string }> },
): Promise<Response> {
  const base = authApiBase();
  if (!base) return NextResponse.json({ error: 'upstream_not_configured' }, { status: 503 });

  const { platform } = await ctx.params;
  const key = platform?.toLowerCase() ?? '';
  if (!(INSTALLABLE as readonly string[]).includes(key)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const incoming = new URL(request.url);
  const upstream = new URL(`${base}/api/oauth/${key}/start`);
  upstream.search = incoming.search;

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  if (!session.ok) {
    // `session_expired` rather than `unauthorized`, matching the catch-all proxy so a
    // stale cookie is recognisable to the client instead of looking like an OAuth bug.
    return NextResponse.json(
      { error: session.reason === 'unavailable' ? 'auth_unavailable' : 'session_expired' },
      { status: session.reason === 'unavailable' ? 503 : 401 },
    );
  }

  // Same construction the catch-all proxy uses, so a client cookie cannot be
  // presented as an operator one: `buildUpstreamHeaders` drops any inbound
  // credential header and sets exactly one from the verified kind.
  const principal: UpstreamPrincipal = { kind: session.payload.kind, sid: session.payload.sid! };
  const headers = buildUpstreamHeaders(new Headers(request.headers), null, principal);

  let res: Response;
  try {
    res = await fetch(upstream, { headers, redirect: 'manual', cache: 'no-store' });
  } catch {
    return NextResponse.json({ error: 'oauth_start_unreachable' }, { status: 502 });
  }

  const location = res.headers.get('location');
  if (location) return NextResponse.redirect(location, 302);

  const body = await res.text();
  return new Response(body || JSON.stringify({ error: 'oauth_start_failed' }), {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}