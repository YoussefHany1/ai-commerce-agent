import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Lets the client distinguish "signed out" from "session store unreachable". */
export async function GET(): Promise<NextResponse> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySession(token);
  if (session.ok) return NextResponse.json({ authenticated: true });
  if (session.reason === 'unavailable') {
    return NextResponse.json({ authenticated: false, error: 'auth_unavailable' }, { status: 503 });
  }
  return NextResponse.json({ authenticated: false });
}
