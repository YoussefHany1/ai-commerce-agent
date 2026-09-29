/**
 * Structural session-cookie check for the Edge middleware.
 *
 * Middleware runs on the Edge runtime, which has no `node:crypto`, so it cannot
 * verify the HMAC. It also cannot reach Redis, so it cannot honour a revocation.
 * All it can do cheaply is confirm the cookie is well-formed and unexpired, which
 * is enough to send a signed-out visitor to the login page instead of rendering a
 * dashboard that will immediately fail its first data request.
 *
 * The authoritative check — HMAC signature and operator session epoch — lives in
 * `lib/server/session.ts` and runs on the Node runtime in the proxy route, which
 * every data request must pass through. Nothing is served on the strength of this
 * check alone.
 *
 * Deliberately reads no secret. `process.env` values referenced from Edge code are
 * inlined at build time, so verifying a signature here would bake the cookie-signing
 * key into the middleware bundle and require it to be identical at build and run
 * time; a silent mismatch there would bounce every operator to the login page. A
 * bad guess is recoverable, an unguessable key is not, and the security value bought
 * by checking it here is nil because the proxy re-checks anyway.
 */

const PAYLOAD_VERSION = 2;

export type EdgeVerifyFailure = 'malformed' | 'expired';

export type EdgeVerifyResult = { ok: true } | { ok: false; reason: EdgeVerifyFailure };

export function verifySessionCookieShape(
  token: string | undefined,
  now = Date.now(),
): EdgeVerifyResult {
  if (!token) return { ok: false, reason: 'malformed' };

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };

  let payload: { v?: unknown; exp?: unknown; kind?: unknown; epoch?: unknown; clientId?: unknown; sid?: unknown };
  try {
    payload = JSON.parse(decodeBase64Url(token.slice(0, dot)));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.v !== PAYLOAD_VERSION) return { ok: false, reason: 'malformed' };
  if (typeof payload.exp !== 'number') return { ok: false, reason: 'malformed' };
  if (payload.kind !== 'operator' && payload.kind !== 'client') return { ok: false, reason: 'malformed' };
  if (typeof payload.epoch !== 'string' || !payload.epoch) return { ok: false, reason: 'malformed' };
  if (payload.kind === 'client' && (typeof payload.clientId !== 'string' || !payload.clientId)) {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.kind === 'client' && (typeof payload.sid !== 'string' || !payload.sid)) {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.exp * 1000 <= now) return { ok: false, reason: 'expired' };

  return { ok: true };
}

/** base64url to text, using the runtime-neutral primitives both runtimes provide. */
function decodeBase64Url(input: string): string {
  const binary = atob(input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
