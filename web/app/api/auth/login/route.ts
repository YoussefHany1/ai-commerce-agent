import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  SESSION_COOKIE,
  newSessionPayload,
  serializeSession,
  sessionCookieOptions,
} from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const PASSWORD_LIMIT = 1024;

type VerifyResponse = { ok?: boolean; epoch?: string; error?: string };

/**
 * Exchanges the operator password for a session cookie.
 *
 * The password is checked by the API, not here: the API owns the scrypt hash and
 * the Redis-backed attempt counter, so the lockout survives restarts and redeploys
 * of this service and is shared across its replicas. This route never sees the
 * stored hash, and never handles the password beyond forwarding it once.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const apiBase = process.env.API_URL?.trim().replace(/\/+$/, '');
  if (!apiBase) return NextResponse.json({ error: 'upstream_not_configured' }, { status: 503 });

  let password: string;
  try {
    const parsed = (await request.json()) as { password?: unknown };
    if (typeof parsed.password !== 'string' || !parsed.password || parsed.password.length > PASSWORD_LIMIT) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    password = parsed.password;
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase}/api/auth/operator/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: 'upstream_unreachable' }, { status: 502 });
  }

  const payload = (await upstream.json().catch(() => null)) as VerifyResponse | null;

  if (!upstream.ok) {
    // 429 keeps the API's Retry-After so the form can tell the operator when to
    // try again; every other failure is reported identically.
    const status = upstream.status === 429 ? 429 : upstream.status === 503 ? 503 : 401;
    const retryAfter = upstream.headers.get('retry-after');
    return NextResponse.json(
      { error: status === 429 ? 'too_many_attempts' : status === 503 ? 'auth_unavailable' : 'invalid_credentials' },
      { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} },
    );
  }

  if (!payload?.ok || typeof payload.epoch !== 'string') {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  (await cookies()).set(SESSION_COOKIE, serializeSession(newSessionPayload(payload.epoch)), sessionCookieOptions());
  return NextResponse.json({ ok: true });
}
