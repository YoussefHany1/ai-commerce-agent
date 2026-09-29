import 'server-only';
import { cookies } from 'next/headers';
import {
  SESSION_COOKIE,
  newClientSessionPayload,
  newOperatorSessionPayload,
  serializeSession,
  sessionCookieOptions,
  type SessionPayload,
} from './session';

/**
 * Server-to-server plumbing for the sign-in flows (login, register, forgot, exchange,
 * logout). These are dedicated BFF routes, not the `/api/*` proxy: the proxy requires a
 * valid session, and these flows are precisely the ones that get one.
 *
 * The exchange side is kind-agnostic on purpose. The browser's Supabase callback hands
 * over a token without saying whether its holder is an operator or a merchant — the same
 * Google button serves both — so this module mints whichever cookie the API's answer
 * names. Deciding earlier would mean the callback had to guess, and a wrong guess is
 * either a client unable to sign in or a merchant handed the operator cookie.
 */

export type AuthApiResponse = {
  ok?: boolean;
  /** Which account the API resolved the token to. Present on exchange answers. */
  kind?: 'operator' | 'client';
  operatorId?: string;
  clientId?: string;
  name?: string;
  email?: string;
  sid?: string;
  epoch?: string;
  /** Operator only: the install-wide epoch, bound into the cookie alongside `epoch`. */
  globalEpoch?: string;
  /** Seconds until the API's session record expires. The cookie must not outlive it. */
  expiresIn?: number;
  error?: string;
};

export function authApiBase(): string | null {
  const base = process.env.API_URL?.trim();
  return base ? base.replace(/\/+$/, '') : null;
}

/**
 * Posts a JSON body to one of the API's unauthenticated auth endpoints.
 *
 * `path` is constrained to this service's own auth routes rather than interpolated from
 * caller input, so this cannot be turned into a request to an arbitrary path or origin.
 */
export async function callAuthApi(
  path: 'client/register' | 'forgot' | 'client/login' | 'operator/login' | 'exchange' | 'logout',
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; payload: Partial<AuthApiResponse> }> {
  const base = authApiBase();
  if (!base) return { status: 503, payload: { error: 'upstream_not_configured' } };

  let res: Response;
  try {
    res = await fetch(`${base}/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return { status: 502, payload: { error: 'upstream_unreachable' } };
  }

  const payload = (await res.json().catch(() => null)) as Partial<AuthApiResponse> | null;
  return { status: res.status, payload: payload ?? {} };
}

/**
 * Mints the `aca_session` cookie from a successful sign-in or exchange answer.
 *
 * Returns false — and writes no cookie — unless the response names a kind and carries
 * every field that kind's payload requires. Failing closed here is what keeps a
 * truncated or unexpected upstream answer from producing a cookie the proxy would then
 * reject on every request.
 *
 * The `kind` must be explicit. Inferring it from the presence of `clientId` would mean
 * a response missing the field that distinguishes a merchant from an administrator
 * silently became one of them.
 */
export async function mintSessionCookie(payload: Partial<AuthApiResponse>): Promise<boolean> {
  const built = buildPayload(payload);
  if (!built) return false;
  (await cookies()).set(
    SESSION_COOKIE,
    serializeSession(built.payload),
    sessionCookieOptions(built.expiresIn),
  );
  return true;
}

/**
 * Builds the cookie payload, or null if the response is not a complete session.
 *
 * Split out from {@link mintSessionCookie} so the shape rules are testable without a
 * cookie jar: the coercion of `name`/`email` and the refusal of a partial answer are the
 * parts worth asserting directly.
 */
export function buildPayload(
  payload: Partial<AuthApiResponse>,
): { payload: SessionPayload; expiresIn: number } | null {
  const sid = str(payload.sid);
  const epoch = str(payload.epoch);
  const name = str(payload.name);
  const email = str(payload.email);
  const expiresIn = num(payload.expiresIn);
  // A session with no stated lifetime would get the fallback TTL, which may outlast the
  // API's own record. Refuse instead of guessing.
  if (!sid || !epoch || expiresIn === null || expiresIn <= 0) return null;

  if (payload.kind === 'operator') {
    const operatorId = str(payload.operatorId);
    const globalEpoch = str(payload.globalEpoch);
    if (!operatorId || !globalEpoch) return null;
    return {
      expiresIn,
      payload: newOperatorSessionPayload({ operatorId, sid, epoch, globalEpoch, expiresIn, name, email }),
    };
  }

  if (payload.kind === 'client') {
    const clientId = str(payload.clientId);
    if (!clientId) return null;
    return {
      expiresIn,
      payload: newClientSessionPayload({ clientId, sid, epoch, expiresIn, name, email }),
    };
  }

  return null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Same-origin `next` values only, so a redirect target can never leave the app. */
export function safeNext(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
  return value;
}
