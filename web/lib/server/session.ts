import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { currentEpoch } from './redis';

export const SESSION_COOKIE = 'aca_session';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

const PAYLOAD_VERSION = 1;

export type SessionPayload = {
  /** Payload format version, so a future change can invalidate old cookies. */
  v: number;
  /** Issued-at, epoch seconds. */
  iat: number;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Operator session epoch this cookie is bound to. */
  epoch: string;
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

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.v !== PAYLOAD_VERSION) return { ok: false, reason: 'malformed' };
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.epoch !== 'string' || !payload.epoch) return { ok: false, reason: 'malformed' };
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
    epoch = await currentEpoch();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  if (signature.payload.epoch !== epoch) return { ok: false, reason: 'stale_epoch' };
  return signature;
}

export function newSessionPayload(epoch: string, now = Date.now()): SessionPayload {
  const iat = Math.floor(now / 1000);
  return { v: PAYLOAD_VERSION, iat, exp: iat + SESSION_TTL_SECONDS, epoch };
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
