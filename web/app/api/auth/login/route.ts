import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  SESSION_COOKIE,
  newClientSessionPayload,
  newSessionPayload,
  serializeSession,
  sessionCookieOptions,
} from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const PASSWORD_LIMIT = 1024;

type OperatorVerifyResponse = { ok?: boolean; epoch?: string; error?: string };

type ClientLoginResponse = {
  ok?: boolean;
  clientId?: string;
  name?: string;
  email?: string;
  sid?: string;
  epoch?: string;
  error?: string;
};

/** Operator verify endpoint (password --> session epoch). */
function operatorVerifyEndpoint(apiBase: string): string {
  return `${apiBase}/api/auth/operator/verify`;
}

/** Client login endpoint (email + password --> sid + clientId + epoch). */
function clientLoginEndpoint(apiBase: string): string {
  return `${apiBase}/api/auth/client/login`;
}

/**
 * Exchanges a password for a session cookie.
 *
 * Two principals share this route: an operator (password only) and a client
 * account (email + password). In both cases the check is done by the API, not
 * here: the API owns the scrypt hash and the Redis-backed attempt counter, so the
 * lockout survives restarts and redeploys of this service and is shared across
 * its replicas. This route never sees a stored hash, and never handles a password
 * beyond forwarding it once.
 *
 * The cookie that comes back encodes the principal (v2 payload): an operator
 * cookie carries the operator session epoch, a client cookie the account id, the
 * raw session id the proxy forwards as `x-client-session`, and the account's
 * session epoch. The proxy and the API are each authoritative over their half.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const apiBase = process.env.API_URL?.trim().replace(/\/+$/, '');
  if (!apiBase) return NextResponse.json({ error: 'upstream_not_configured' }, { status: 503 });

  let kind: 'operator' | 'client';
  let email: string | undefined;
  let password: string;
  try {
    const parsed = (await request.json()) as {
      kind?: unknown;
      email?: unknown;
      password?: unknown;
    };
    const unknownKind = parsed.kind === 'operator' ? 'operator' : parsed.kind === 'client' ? 'client' : null;
    if (!unknownKind) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    if (typeof parsed.password !== 'string' || !parsed.password || parsed.password.length > PASSWORD_LIMIT) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (unknownKind === 'client') {
      if (typeof parsed.email !== 'string' || !parsed.email || parsed.email.length > 320) {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
      }
      email = parsed.email;
    }
    kind = unknownKind;
    password = parsed.password;
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      kind === 'operator' ? operatorVerifyEndpoint(apiBase) : clientLoginEndpoint(apiBase),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(kind === 'operator' ? { password } : { email, password }),
        cache: 'no-store',
      },
    );
  } catch {
    return NextResponse.json({ error: 'upstream_unreachable' }, { status: 502 });
  }

  if (!upstream.ok) {
    // 429 keeps the API's Retry-After so the form can tell the caller when to
    // try again; every other failure is reported identically.
    const status = upstream.status === 429 ? 429 : upstream.status === 503 ? 503 : 401;
    const retryAfter = upstream.headers.get('retry-after');
    return NextResponse.json(
      { error: status === 429 ? 'too_many_attempts' : status === 503 ? 'auth_unavailable' : 'invalid_credentials' },
      { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} },
    );
  }

  if (kind === 'client') {
    const payload = (await upstream.json().catch(() => null)) as ClientLoginResponse | null;
    if (!payload?.sid || typeof payload.clientId !== 'string' || typeof payload.epoch !== 'string') {
      return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
    }
    (await cookies()).set(
      SESSION_COOKIE,
      serializeSession(
        newClientSessionPayload({
          clientId: payload.clientId,
          sid: payload.sid,
          epoch: payload.epoch,
          name: typeof payload.name === 'string' ? payload.name : undefined,
          email: typeof payload.email === 'string' ? payload.email : undefined,
        }),
      ),
      sessionCookieOptions(),
    );
    return NextResponse.json({ ok: true });
  }

  const payload = (await upstream.json().catch(() => null)) as OperatorVerifyResponse | null;
  if (!payload?.ok || typeof payload.epoch !== 'string') {
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  (await cookies()).set(SESSION_COOKIE, serializeSession(newSessionPayload(payload.epoch)), sessionCookieOptions());
  return NextResponse.json({ ok: true });
}