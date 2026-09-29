import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * Reports the current session so the shell can branch on it.
 *
 * Returns the principal kind and, for a client, the profile fields the dashboard
 * shows instead of having each page reach into the data API. Enables distinguishing
 * "signed out", "signed in as operator", and "signed in as a client account" —
 * and, as before, "signed out" from "session store unreachable".
 */
export async function GET(): Promise<NextResponse> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  if (session.ok) {
    const payload = session.payload;
    if (payload.kind === 'client') {
      return NextResponse.json({
        authenticated: true,
        kind: 'client',
        clientId: payload.clientId,
        name: payload.name ?? null,
        email: payload.email ?? null,
      });
    }
    return NextResponse.json({ authenticated: true, kind: 'operator' });
  }
  if (session.reason === 'unavailable') {
    return NextResponse.json({ authenticated: false, error: 'auth_unavailable' }, { status: 503 });
  }
  return NextResponse.json({ authenticated: false });
}