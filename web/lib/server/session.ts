import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { currentEpoch, currentClientEpoch, currentOperatorEpoch } from './redis';
import { isSessionPayload, PAYLOAD_VERSION, type SessionPayload } from './sessionShape';

// The shape rules are shared with the Edge middleware, which cannot import this file
// (it needs `node:crypto`). They are re-exported here so callers of the Node-side
// session API have one import site for the whole thing.
export { isSessionPayload, PAYLOAD_VERSION };
export type { SessionPayload, SessionKind } from './sessionShape';

export const SESSION_COOKIE = 'aca_session';
/**
 * Fallback cookie lifetime, used only when a caller has no `expiresIn` to pass — the
 * `sessionCookieOptions()` default. Sign-in always supplies the API's own figure, so
 * this exists for the specs and for a caller minting a cookie by hand.
 */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

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
 * includes the epochs, and therefore revocation) happens in the Node-runtime proxy
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
 * epoch(s).
 *
 * Fails closed when Redis is unreachable. A verification outage must not become an
 * authentication bypass, so the request is refused rather than let through on an
 * unverified cookie.
 */
export async function verifySession(token: string | undefined): Promise<VerifyResult> {
  const signature = verifySessionSignature(token);
  if (!signature.ok) return signature;

  const p = signature.payload;
  try {
    // Both kinds live in the same Redis the API writes; the key names and seeding
    // rules are duplicated by contract in `redis.ts`.
    if (p.kind === 'client') {
      if (p.epoch !== (await currentClientEpoch(p.clientId!))) {
        return { ok: false, reason: 'stale_epoch' };
      }
      return signature;
    }

    // An operator has two: their own (suspension, per-person revocation) and the
    // install-wide one (revoke-all). Both must match, so neither a targeted nor a
    // blanket revocation can be laundered past the proxy by holding the other.
    const [own, global] = await Promise.all([
      currentOperatorEpoch(p.operatorId!),
      currentEpoch(),
    ]);
    if (p.epoch !== own) return { ok: false, reason: 'stale_epoch' };
    if (p.globalEpoch !== global) return { ok: false, reason: 'stale_epoch' };
    return signature;
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * Both cookie lifetimes come from the API's own answer, not from a constant repeated
 * here. The auth routes return `expiresIn` alongside the sid, and it is exactly the
 * Redis TTL they set, so deriving `exp` and `maxAge` from it means a cookie can never
 * outlive the session record it points at — the failure that would otherwise show up as
 * an endless signed-in-but-401 loop after a TTL change on the other service. It also
 * means the operator and client lifetimes can differ without this file knowing why.
 */
export function newOperatorSessionPayload(
  input: {
    operatorId: string;
    sid: string;
    epoch: string;
    globalEpoch: string;
    expiresIn: number;
    name?: string;
    email?: string;
  },
  now = Date.now(),
): SessionPayload {
  const iat = Math.floor(now / 1000);
  return {
    v: PAYLOAD_VERSION,
    kind: 'operator',
    iat,
    exp: iat + input.expiresIn,
    epoch: input.epoch,
    globalEpoch: input.globalEpoch,
    operatorId: input.operatorId,
    sid: input.sid,
    name: input.name,
    email: input.email,
  };
}

export function newClientSessionPayload(
  input: { clientId: string; sid: string; epoch: string; expiresIn: number; name?: string; email?: string },
  now = Date.now(),
): SessionPayload {
  const iat = Math.floor(now / 1000);
  return {
    v: PAYLOAD_VERSION,
    kind: 'client',
    iat,
    exp: iat + input.expiresIn,
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

export function sessionCookieOptions(maxAge: number = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: secure(),
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  };
}

export function clearedSessionCookieOptions() {
  return { httpOnly: true, secure: secure(), sameSite: 'lax' as const, path: '/', maxAge: 0 };
}
