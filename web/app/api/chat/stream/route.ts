import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/server/session';
import { buildUpstreamHeaders, MAX_BODY_BYTES, type UpstreamPrincipal } from '@/lib/server/upstream';

export const dynamic = 'force-dynamic';

/**
 * Dedicated BFF route that pipes the chat SSE stream from the API.
 *
 * This exists instead of an entry in the generic `[...path]` proxy because that
 * proxy reads the upstream body with `await upstream.text()`, which for a stream
 * that only settles when the answer is complete would deliver every token at once
 * — the exact latency this route is here to remove. The Fastify `/api/chat` route
 * already speaks SSE when the request carries `Accept: text/event-stream`, so this
 * only has to authenticate, forward, and hand the body through unbuffered.
 *
 * Credentials follow the generic proxy rule: the verified cookie decides the
 * principal, and only the session id is forwarded. `authorization` is relayed
 * because the chat endpoint authenticates with the guest bearer token the
 * dashboard minted via `/api/session`; no dashboard route trusts that header.
 */

function apiBase(): string | null {
  const base = process.env.API_URL?.trim();
  if (!base) return null;
  return base.replace(/\/+$/, '');
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

export async function POST(request: Request): Promise<Response> {
  const base = apiBase();
  if (!base) return json({ error: 'upstream_not_configured' }, 503);

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  if (!session.ok) {
    const status = session.reason === 'unavailable' ? 503 : 401;
    return json(
      { error: session.reason === 'unavailable' ? 'auth_unavailable' : 'session_expired' },
      status,
    );
  }
  const principal: UpstreamPrincipal = { kind: session.payload.kind, sid: session.payload.sid! };

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413);
  }
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large' }, 413);
  }

  const headers = buildUpstreamHeaders(request.headers, 'application/json', principal);
  headers.set('accept', 'text/event-stream');

  const target = new URL(`${base}/api/chat`);
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers,
      body,
      cache: 'no-store',
      // Abort the generation upstream when the shopper closes the tab.
      signal: request.signal,
    });
  } catch {
    return json({ error: 'upstream_unreachable' }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const payload = await upstream.text();
    return new Response(payload, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Defeats proxy-side buffering, which would reintroduce the batching this
      // route exists to avoid.
      'x-accel-buffering': 'no',
    },
  });
}
