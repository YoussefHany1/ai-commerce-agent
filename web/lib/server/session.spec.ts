import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const currentEpoch = vi.fn<() => Promise<string>>();

// Only the Redis read is stubbed; everything under test is the real implementation.
vi.mock('./redis', () => ({ currentEpoch }));

const SECRET = 'a'.repeat(48);

const {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  newSessionPayload,
  serializeSession,
  verifySession,
  verifySessionSignature,
  sessionCookieOptions,
  clearedSessionCookieOptions,
} = await import('./session');
const { verifySessionCookieShape } = await import('./session-edge');

// Real wall-clock, because verifySession/verifySessionCookieEdge default to
// Date.now(); a fixed past timestamp would read as expired rather than exercise the
// behaviour under test.
const NOW = Date.now();

function mint(epoch = 'epoch-1', now = NOW): string {
  return serializeSession(newSessionPayload(epoch, now));
}

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  currentEpoch.mockReset();
  currentEpoch.mockResolvedValue('epoch-1');
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.SESSION_COOKIE_SECURE;
  vi.unstubAllEnvs();
});

describe('serializeSession', () => {
  it('produces a payload.signature pair with no padding characters', () => {
    const token = mint();
    expect(token.split('.')).toHaveLength(2);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('round-trips through verification', () => {
    const result = verifySessionSignature(mint(), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.epoch).toBe('epoch-1');
      expect(result.payload.exp * 1000 - result.payload.iat * 1000).toBe(SESSION_TTL_SECONDS * 1000);
    }
  });
});

describe('verifySessionSignature', () => {
  it('rejects a missing cookie', () => {
    expect(verifySessionSignature(undefined)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an unsigned cookie', () => {
    const body = Buffer.from(JSON.stringify(newSessionPayload('epoch-1', NOW))).toString('base64url');
    expect(verifySessionSignature(body)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a tampered payload', () => {
    const token = mint();
    const [body, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...newSessionPayload('epoch-1', NOW), epoch: 'attacker' }),
    ).toString('base64url');
    expect(verifySessionSignature(`${forged}.${signature}`)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(body.split('.')).toHaveLength(1);
  });

  it('rejects a signature made with a different secret', () => {
    const token = mint();
    process.env.SESSION_SECRET = 'b'.repeat(48);
    expect(verifySessionSignature(token)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a cookie signed with a short or absent secret', () => {
    const token = mint();
    delete process.env.SESSION_SECRET;
    // Fail closed: a misconfigured secret must not read as a valid session.
    expect(verifySessionSignature(token)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('accepts a cookie up to its expiry and rejects it at the boundary', () => {
    const token = mint('epoch-1', NOW);
    // Read the real expiry rather than recomputing it: `iat` is truncated to whole
    // seconds, so NOW + TTL is up to a second past the true boundary.
    const exp = payloadOf(token).exp * 1000;
    expect(verifySessionSignature(token, exp - 1).ok).toBe(true);
    expect(verifySessionSignature(token, exp)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a payload from a future format version', () => {
    const payload = { ...newSessionPayload('epoch-1', NOW), v: 2 };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = sign(body);
    expect(verifySessionSignature(token, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a payload with no epoch', () => {
    const { v, iat, exp } = newSessionPayload('epoch-1', NOW);
    const body = Buffer.from(JSON.stringify({ v, iat, exp })).toString('base64url');
    expect(verifySessionSignature(sign(body), NOW)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('verifySession', () => {
  it('accepts a cookie bound to the current epoch', async () => {
    await expect(verifySession(mint('epoch-1'))).resolves.toMatchObject({ ok: true });
  });

  it('rejects a cookie issued before the last revocation', async () => {
    // This is the path that makes `npm run revoke-operator-sessions` effective.
    currentEpoch.mockResolvedValue('epoch-2');
    await expect(verifySession(mint('epoch-1'))).resolves.toEqual({
      ok: false,
      reason: 'stale_epoch',
    });
  });

  it('fails closed when the session store is unreachable', async () => {
    currentEpoch.mockRejectedValue(new Error('redis down'));
    await expect(verifySession(mint())).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('does not reach for the session store when the signature is already bad', async () => {
    currentEpoch.mockRejectedValue(new Error('should not be called'));
    await expect(verifySession('garbage')).resolves.toMatchObject({ ok: false });
    expect(currentEpoch).not.toHaveBeenCalled();
  });
});

describe('cookie options', () => {
  it('keeps the cookie out of JavaScript and off cross-site requests', () => {
    const options = sessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.maxAge).toBe(SESSION_TTL_SECONDS);
  });

  it('is Secure in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(sessionCookieOptions().secure).toBe(true);
  });

  it('drops Secure outside production so plain-http local login works', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(sessionCookieOptions().secure).toBe(false);
  });

  it('honours an explicit override', () => {
    process.env.SESSION_COOKIE_SECURE = 'true';
    expect(sessionCookieOptions().secure).toBe(true);
    process.env.SESSION_COOKIE_SECURE = 'false';
    expect(sessionCookieOptions().secure).toBe(false);
  });

  it('clears the cookie with the same attributes it was set with', () => {
    // A mismatched Secure or Path would leave the original cookie in place.
    expect(clearedSessionCookieOptions()).toMatchObject({ maxAge: 0, path: '/', httpOnly: true });
  });

  it('names the cookie the proxy and middleware both read', () => {
    expect(SESSION_COOKIE).toBe('aca_session');
  });
});

describe('edge shape check', () => {
  it('accepts a cookie minted by the Node runtime', () => {
    // The Edge path and the Node path must agree on the encoding, or every
    // dashboard request would bounce to the login page.
    expect(verifySessionCookieShape(mint(), NOW)).toEqual({ ok: true });
  });

  it('rejects an expired cookie at the boundary', () => {
    const token = mint();
    const exp = payloadOf(token).exp * 1000;
    expect(verifySessionCookieShape(token, exp - 1)).toEqual({ ok: true });
    expect(verifySessionCookieShape(token, exp)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a missing, unsigned, or undecodable cookie', () => {
    expect(verifySessionCookieShape(undefined, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifySessionCookieShape('nodot', NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifySessionCookieShape('.sig', NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifySessionCookieShape('body.', NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifySessionCookieShape('!!!.sig', NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a payload that is not a session', () => {
    const notJson = Buffer.from('hello').toString('base64url');
    expect(verifySessionCookieShape(`${notJson}.sig`, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });

    const { v, iat, exp } = payloadOf(mint());
    const noEpoch = Buffer.from(JSON.stringify({ v, iat, exp })).toString('base64url');
    expect(verifySessionCookieShape(`${noEpoch}.sig`, NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('reads no secret, so a rotated key cannot lock operators out of the shell', () => {
    // Mint first: the Node signer needs the key, the Edge check must not.
    const token = mint();
    delete process.env.SESSION_SECRET;
    expect(verifySessionCookieShape(token, NOW)).toEqual({ ok: true });
  });
});

function sign(body: string): string {
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
}

function payloadOf(token: string): { v: number; iat: number; exp: number; epoch: string } {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}
