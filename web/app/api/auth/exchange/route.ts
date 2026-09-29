import { NextResponse } from 'next/server';
import { callClientAuth, mintClientSessionCookie } from '@/lib/server/clientExchange';

export const dynamic = 'force-dynamic';

/**
 * Trades a Supabase access token (from Google OAuth, an email confirmation, or a
 * completed reset) for a session cookie. The token never persists here: it is
 * exchanged server-side for the API's sid and dropped.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: { accessToken?: unknown };
  try {
    body = (await request.json()) as { accessToken?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (typeof body.accessToken !== 'string' || !body.accessToken || body.accessToken.length > 8192) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const out = await callClientAuth('exchange', { accessToken: body.accessToken });
  if (out.status !== 200) return NextResponse.json(out.payload, { status: out.status });

  const minted = await mintClientSessionCookie(out.payload);
  if (!minted) return NextResponse.json({ error: 'auth_unavailable' }, { status: 503 });
  return NextResponse.json({ ok: true });
}