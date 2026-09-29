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
 * Both principals post the same shape — `kind`, `email`, `password` — because both
 * authenticate the same way now. An operator used to post a password with no username,
 * to a `/verify` route that answered `{ok}` and nothing else; there was nowhere in that
 * exchange to put an identity, so the cookie could only carry the install-wide epoch and
 * the shell could not say who was signed in. Asking for the email costs one field and
 * makes the operator a person; Supabase checks the credential, and the API decides
 * whether the address belongs to an operator.
 *
 * The `kind` is still explicit because the two login routes are different upstream
 * endpoints with different lockout buckets and different rows, not because the
 * credential says so. What it must never be is inferred from a successful password:
 * the API answers 401 for a client who typed an operator's address, and this route
 * passes that through unchanged.
 *
 * Nothing here sees a stored credential. The password is forwarded once to the API,
 * which owns the Supabase call, the Redis attempt counter and the per-IP/per-account
 * lockout, so the lockout survives a redeploy of this service and is shared across its
 * replicas.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const apiBase = authApiBase();
  if (!apiBase) return NextResponse.json({ error: 'upstream_not_configured' }, { status: 503 });

  let kind: 'operator' | 'client';
  let email: string;
  let password: string;
  try {
    const parsed = (await request.json()) as { kind?: unknown; email?: unknown; password?: unknown };
    if (parsed.kind !== 'operator' && parsed.kind !== 'client') {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (typeof parsed.email !== 'string' || !parsed.email || parsed.email.length > EMAIL_LIMIT) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (typeof parsed.password !== 'string' || !parsed.password || parsed.password.length > PASSWORD_LIMIT) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    kind = parsed.kind;
    email = parsed.email;
    password = parsed.password;
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase}/api/auth/${kind}/login`, {
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

  // The API names the kind it actually authenticated, and that is what gets written.
  // The request's `kind` only chose the endpoint; taking it from the answer is what
  // stops a client from minting an operator cookie by posting `kind: 'operator'`
  // alongside a client account's password.
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
