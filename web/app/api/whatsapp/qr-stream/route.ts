import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * Dedicated BFF route for the WhatsApp QR event stream.
 *
 * This exists instead of an entry in the generic `[...path]` proxy because the proxy
 * reads the upstream response with `await upstream.text()`. For an SSE stream that
 * never ends during pairing, that read does not return until the connection closes —
 * so the browser would sit on a hung request and receive every event at once, in order,
 * long after they were superseded. A QR rotates roughly every 20 seconds, which is
 * exactly the case where "all events eventually at once" is useless.
 *
 * The alternative, polling `qr-status`, looks simpler but forces every open dashboard
 * tab to re-poll at the QR refresh rate and still misses the `open` / `replaced`
 * transitions between polls.
 *
 * Credentials follow the same rule as the generic proxy: the verified cookie decides,
 * and only the session id is forwarded. The client's own headers are never relayed, so
 * a caller cannot inject a wider credential through this route.
 */

function apiBase(): string | null {
  const base = process.env.API_URL?.trim();
  if (!base) return null;
  return base.replace(/\/+$/, '');
}

export async function GET(request: Request): Promise<Response> {
  const base = apiBase();
  if (!base) return Response.json({ error: 'upstream_not_configured' }, { status: 503 });

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  if (!session.ok) {
    const status = session.reason === 'unavailable' ? 503 : 401;
    return Response.json(
      { error: session.reason === 'unavailable' ? 'auth_unavailable' : 'session_expired' },
      { status },
    );
  }

  // storeId is a validated UUID upstream; forwarding the raw query value keeps this route
  // free of a second allowlist, and the API's `requireDashboard` does the real check —
  // a store this session does not own gets a 403 from the API, not from here.
  const incoming = new URL(request.url);
  const storeId = incoming.searchParams.get('storeId');
  if (!storeId) return Response.json({ error: 'bad_request' }, { status: 400 });

  const target = new URL(`${base}/api/whatsapp/qr-stream`);
  target.searchParams.set('storeId', storeId);

  const headers = new Headers();
  headers.set(
    session.payload.kind === 'operator' ? 'x-operator-session' : 'x-client-session',
    session.payload.sid!,
  );

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers,
      cache: 'no-store',
      // Required for the stream to be returned immediately rather than buffered.
      signal: request.signal,
    });
  } catch {
    return Response.json({ error: 'upstream_unreachable' }, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    const payload = await upstream.text();
    return new Response(payload, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Defeats proxy-side buffering, which would otherwise reintroduce the exact
      // batching this route exists to avoid.
      'x-accel-buffering': 'no',
    },
  });
}