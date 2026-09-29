import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, verifySessionSignature, clearedSessionCookieOptions } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/**
 * Clears the session cookie and revokes its sid upstream.
 *
 * Clearing the cookie is unconditional and local: logout must succeed even when the
 * API is down, or a user whose session store is already broken could never leave. The
 * upstream revocation is best-effort for the same reason — a dead sid is a no-op on the
 * API side, and a session that raced a Redis flush is logged out anyway, because the
 * flush moved the epoch.
 *
 * Revocation goes to the unified `/api/auth/logout`, which revokes whichever sid it is
 * given. The cookie is verified for its signature and kind only — deliberately not
 * against the epochs, because a session already invalidated by a revocation is exactly
 * the one whose sid most needs deleting, and refusing to send it would leave it alive
 * until its TTL.
 */
export async function POST(): Promise<NextResponse> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  const verified = token ? verifySessionSignature(token) : { ok: false as const };

  if (verified.ok && verified.payload.sid) {
    const apiBase = process.env.API_URL?.trim().replace(/\/+$/, '');
    if (apiBase) {
      const header =
        verified.payload.kind === 'operator' ? 'x-operator-session' : 'x-client-session';
      try {
        await fetch(`${apiBase}/api/auth/logout`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [header]: verified.payload.sid },
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