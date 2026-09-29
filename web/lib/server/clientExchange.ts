import 'server-only';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, newClientSessionPayload, serializeSession, sessionCookieOptions } from './session';

/**
 * Server-to-server plumbing for the client auth routes (register/forgot/exchange/
 * reset-complete). These are dedicated BFF routes, not the `/api/*` proxy: the
 * proxy requires a valid session, and these flows are precisely the ones that get
 * signed in.
 */

export type ClientAuthResponse = {
  ok?: boolean;
  clientId?: string;
  name?: string;
  email?: string;
  sid?: string;
  epoch?: string;
  error?: string;
};

export function clientApiBase(): string | null {
  const base = process.env.API_URL?.trim();
  return base ? base.replace(/\/+$/, '') : null;
}

/** Posts a JSON body to one of the API's public client auth endpoints. */
export async function callClientAuth(
  action: 'register' | 'forgot' | 'exchange' | 'reset-complete',
  body: unknown,
): Promise<{ status: number; payload: Partial<ClientAuthResponse> }> {
  const base = clientApiBase();
  if (!base) return { status: 503, payload: { error: 'upstream_not_configured' } };

  let res: Response;
  try {
    res = await fetch(`${base}/api/auth/client/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return { status: 502, payload: { error: 'upstream_unreachable' } };
  }

  const payload = (await res.json().catch(() => null)) as Partial<ClientAuthResponse> | null;
  return { status: res.status, payload: payload ?? {} };
}

/**
 * Mints the `aca_session` cookie from a successful `/exchange` response. Returns
 * false when the response is not, in fact, a session (so callers can fail closed).
 */
export async function mintClientSessionCookie(payload: Partial<ClientAuthResponse>): Promise<boolean> {
  if (
    typeof payload.sid !== 'string' ||
    typeof payload.clientId !== 'string' ||
    typeof payload.epoch !== 'string'
  ) {
    return false;
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
  return true;
}

/** Same-origin `next` values only, so a redirect target can never leave the app. */
export function safeNext(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}