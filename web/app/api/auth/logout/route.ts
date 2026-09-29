import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionSignature, clearedSessionCookieOptions } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * Clears the session cookie and, for a client account, revokes its sid upstream.
 *
 * Clearing the cookie is unconditional and local: logout must succeed even when
 * the API is down, or a user whose session store is already broken could never
 * leave. The upstream revocation is best-effort — a dead sid is a no-op on the
 * API side, and a client whose logout raced a Redis flush is logged out anyway
 * because the flush moved the account epoch.
 */
export async function POST(): Promise<NextResponse> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const verified = token ? verifySessionSignature(token) : { ok: false as const };

  if (verified.ok && verified.payload.kind === 'client' && verified.payload.sid) {
    const apiBase = process.env.API_URL?.trim().replace(/\/+$/, '');
    if (apiBase) {
      try {
        await fetch(`${apiBase}/api/auth/client/logout`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-client-session': verified.payload.sid },
          body: '{}',
          cache: 'no-store',
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Best-effort; the cookie is still cleared below.
      }
    }
  }

  store.set(SESSION_COOKIE, '', clearedSessionCookieOptions());
  return NextResponse.json({ ok: true });
}