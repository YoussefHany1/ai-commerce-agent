import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { authApiBase, buildPayload, type AuthApiResponse } from '@/lib/server/authExchange';
import { SESSION_COOKIE, serializeSession, sessionCookieOptions } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const PASSWORD_LIMIT = 1024;
const EMAIL_LIMIT = 320;

/**
 * Exchanges an email and password for a session cookie.
 *
 * There is one form and one upstream endpoint now. It used to post a `kind` that chose
 * between `/api/auth/operator/login` and `/api/auth/client/login`, but the credential
 * was identical — both were email and password against Supabase — so the field only made
 * the person declare a role they should not have to know. The API verifies the password
 * and resolves the kind itself, and the answer's `kind` is what decides the cookie.
 *
 * Nothing here sees a stored credential. The password is forwarded once to the API,
 * which owns the Supabase call, the Redis attempt counter and the per-IP/per-account
 * lockout, so the lockout survives a redeploy of this service and is shared across its
 * replicas.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const apiBase = authApiBase();
  if (!apiBase) return NextResponse.json({ error: 'upstream_not_configured' }, { status: 503 });

  let email: string;
  let password: string;
  try {
    const parsed = (await request.json()) as { email?: unknown; password?: unknown };
    if (typeof parsed.email !== 'string' || !parsed.email || parsed.email.length > EMAIL_LIMIT) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (typeof parsed.password !== 'string' || !parsed.password || parsed.password.length > PASSWORD_LIMIT) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    email = parsed.email;
    password = parsed.password;
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ error: 'upstream_unreachable' }, { status: 502 });
  }

  if (!upstream.ok) {
    // 429 keeps the API's Retry-After so the form can say when to try again; every
    // other failure is reported identically, so a wrong email, a wrong password, an
    // unconfirmed signup and a suspended account are the same answer to a caller.
    const status = upstream.status === 429 ? 429 : upstream.status === 503 ? 503 : 401;
    const retryAfter = upstream.headers.get('retry-after');
    return NextResponse.json(
      {
        error:
          status === 429 ? 'too_many_attempts' : status === 503 ? 'auth_unavailable' : 'invalid_credentials',
      },
      { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} },
    );
  }

  // The API names the kind it resolved — operator or client — and that is what gets
  // written. There is no request field left to forge, so a merchant can no longer be
  // handed the operator cookie by posting a kind alongside their own password.
  const payload = (await upstream.json().catch(() => null)) as Partial<AuthApiResponse> | null;
  const built = payload ? buildPayload(payload) : null;
  if (!built) return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });

  (await cookies()).set(
    SESSION_COOKIE,
    serializeSession(built.payload),
    sessionCookieOptions(built.expiresIn),
  );
  return NextResponse.json({ ok: true, kind: built.payload.kind });
}
