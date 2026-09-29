import { NextResponse } from 'next/server';
import { callAuthApi, mintSessionCookie } from '@/lib/server/authExchange';

export const dynamic = 'force-dynamic';

/**
 * Trades a Supabase access token (Google OAuth, an email confirmation, or a completed
 * reset) for a session cookie. The token never persists here: it is exchanged
 * server-side for the API's sid and dropped, so the browser ends up holding only the
 * HTTP-only `aca_session` cookie.
 *
 * Which kind of session that is comes back from the API, not from the request. The
 * caller does not say "I am an operator" — the token says who it belongs to, and the
 * cookie minted is the one that account gets. `rotate` is accepted from the reset flow
 * only: it tells the API to move that account's epoch first, which is what makes a
 * password reset evict every other device in the same round trip.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: { accessToken?: unknown; rotate?: unknown };
  try {
    body = (await request.json()) as { accessToken?: unknown; rotate?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (typeof body.accessToken !== 'string' || !body.accessToken || body.accessToken.length > 8192) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const out = await callAuthApi('exchange', {
    accessToken: body.accessToken,
    // Only ever a strict boolean, so a truthy string from a caller cannot rotate.
    rotate: body.rotate === true ? true : undefined,
  });
  if (out.status !== 200) return NextResponse.json(out.payload, { status: out.status });

  const minted = await mintSessionCookie(out.payload);
  if (!minted) return NextResponse.json({ error: 'auth_unavailable' }, { status: 503 });
  return NextResponse.json({ ok: true, kind: out.payload.kind });
}
