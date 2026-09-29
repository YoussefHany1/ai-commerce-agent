import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { currentEpoch, currentClientEpoch } from './redis';

export const SESSION_COOKIE = 'aca_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/**
 * Payload format version. Bumping this invalidates every existing cookie, which is
 * the intended coupling: the v2 payload carries `kind` and, for client sessions,
 * the account id, sid and display name that the proxy and the session endpoint
 * previously had no way to express. Old v1 operator cookies must not half-verify
 * against a v2 validator, so a version bump is a deliberate log-everyone-out.
 */
const PAYLOAD_VERSION = 2;

export type SessionKind = 'operator' | 'client';

export type SessionPayload = {
  /** Payload format version, so a future change can invalidate old cookies. */
  v: number;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Who owns this session: the install (operator) or a dashboard account (client). */
  kind: SessionKind;
  /**
   * The epoch this cookie is bound to — the operator session epoch for
   * `operator`, the account's client session epoch for `client`. A revocation
   * (operator revoke script, a client password change or suspension) moves the
   * epoch and this cookie stops verifying.
   */
  epoch: string;
  /** `client` only: the dashboard account id, displayed in the shell. */
  clientId?: string;
  /** `client` only: the raw session id the proxy forwards in `x-client-session`. */
  sid?: string;
  /** `client` only: display name for the shell. */
  name?: string;
  /** `client` only: contact for the shell. */
  email?: string;
};

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error('SESSION_SECRET is required and must be at least 32 characters');
  }
  return value;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

export function serializeSession(payload: SessionPayload): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export type VerifyFailure = 'malformed' | 'bad_signature' | 'expired' | 'stale_epoch' | 'unavailable';

export type VerifyResult = { ok: true; payload: SessionPayload } | { ok: false; reason: VerifyFailure };

/**
 * Verifies a cookie's signature and expiry.
 *
 * Deliberately does not consult the session epoch: the authoritative check (which
 * includes the epoch, and therefore revocation) happens in the Node-runtime proxy
 * route. Middleware only needs to know whether the cookie is structurally valid so
 * it can send an unauthenticated visitor to the login page.
 */
export function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as SessionPayload;
  if (p.v !== PAYLOAD_VERSION) return false;
  if (typeof p.iat !== 'number' || typeof p.exp !== 'number') return false;
  if (p.kind !== 'operator' && p.kind !== 'client') return false;
  if (typeof p.epoch !== 'string' || !p.epoch) return false;
  if (p.kind === 'client' && (typeof p.clientId !== 'string' || !p.clientId)) return false;
  if (p.kind === 'client' && (typeof p.sid !== 'string' || !p.sid)) return false;
  return true;
}

export function verifySessionSignature(token: string | undefined, now = Date.now()): VerifyResult {
  if (!token) return { ok: false, reason: 'malformed' };

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };

  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  let expected: string;
  try {
    expected = sign(body);
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (!isSessionPayload(payload)) return { ok: false, reason: 'malformed' };
  if (payload.exp * 1000 <= now) return { ok: false, reason: 'expired' };

  return { ok: true, payload };
}

/**
 * Authoritative check for proxied requests: signature, expiry, and the session
 * epoch.
 *
 * Fails closed when Redis is unreachable. A verification outage must not become an
 * authentication bypass, so the request is refused rather than let through on an
 * unverified cookie.
 */
export async function verifySession(token: string | undefined): Promise<VerifyResult> {
  const signature = verifySessionSignature(token);
  if (!signature.ok) return signature;

  let epoch: string;
  try {
    // An operator cookie is bound to the global operator epoch; a client cookie to
    // the account's own epoch. Both live in the same Redis the API writes.
    epoch =
      signature.payload.kind === 'client'
        ? await currentClientEpoch(signature.payload.clientId!)
        : await currentEpoch();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  if (signature.payload.epoch !== epoch) return { ok: false, reason: 'stale_epoch' };
  return signature;
}

export function newSessionPayload(epoch: string, now = Date.now()): SessionPayload {
  const iat = Math.floor(now / 1000);
  return { v: PAYLOAD_VERSION, kind: 'operator', iat, exp: iat + SESSION_TTL_SECONDS, epoch };
}

export function newClientSessionPayload(
  input: { clientId: string; sid: string; epoch: string; name?: string; email?: string },
  now = Date.now(),
): SessionPayload {
  const iat = Math.floor(now / 1000);
  return {
    v: PAYLOAD_VERSION,
    kind: 'client',
    iat,
    exp: iat + SESSION_TTL_SECONDS,
    epoch: input.epoch,
    clientId: input.clientId,
    sid: input.sid,
    name: input.name,
    email: input.email,
  };
}

/**
 * `Secure` is on by default because the dashboard is only ever served over HTTPS
 * in production, and a cookie without it would travel in cleartext.
 *
 * It can be turned off explicitly with SESSION_COOKIE_SECURE=false, which is what
 * local HTTP development and the docker-compose smoke test need — a browser will
 * otherwise refuse to store the cookie, making login untestable over plain http.
 */
function secure(): boolean {
  const override = process.env.SESSION_COOKIE_SECURE?.toLowerCase();
  if (override === 'false') return false;
  if (override === 'true') return true;
  return process.env.NODE_ENV === 'production';
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: secure(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}

export function clearedSessionCookieOptions() {
  return { httpOnly: true, secure: secure(), sameSite: 'lax' as const, path: '/', maxAge: 0 };
}
