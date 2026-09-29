import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const currentEpoch = vi.fn<() => Promise<string>>();
const currentClientEpoch = vi.fn<(clientId: string) => Promise<string>>();

// Only the Redis reads are stubbed; everything under test is the real implementation.
vi.mock('./redis', () => ({ currentEpoch, currentClientEpoch }));

const SECRET = 'a'.repeat(48);

const {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  newSessionPayload,
  newClientSessionPayload,
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

function mintClient(
  input: { name?: string; email?: string } = {},
  epoch = 'client-epoch-1',
  now = NOW,
): string {
  return serializeSession(
    newClientSessionPayload({ clientId: 'client-1', sid: 'sid-1', epoch, name: input.name, email: input.email }, now),
  );
}

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  currentEpoch.mockReset();
  currentEpoch.mockResolvedValue('epoch-1');
  currentClientEpoch.mockReset();
  currentClientEpoch.mockResolvedValue('client-epoch-1');
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.SESSION_COOKIE_SECURE;
  vi.unstubAllEnvs();
});

describe('serializeSession', () => {
  it('produces a payload.signature pair with no padding characters', () => {
    const token = mint();
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('mints an operator payload the reader can round-trip', () => {
    const token = mint('epoch-1', NOW);
    expect(token.split('.')).toHaveLength(2);
    const result = verifySessionSignature(token, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.epoch).toBe('epoch-1');
      expect(result.payload.kind).toBe('operator');
      expect(result.payload.exp * 1000 - result.payload.iat * 1000).toBe(SESSION_TTL_SECONDS * 1000);
    }
  });

  it('mints a client payload carrying the account id and sid', () => {
    const token = mintClient({ name: 'Ace Widgets', email: 'a@example.com' }, 'client-epoch-1', NOW);
    const result = verifySessionSignature(token, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.kind).toBe('client');
      expect(result.payload.clientId).toBe('client-1');
      expect(result.payload.sid).toBe('sid-1');
      expect(result.payload.epoch).toBe('client-epoch-1');
      expect(result.payload.name).toBe('Ace Widgets');
      expect(result.payload.email).toBe('a@example.com');
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
    const payload = { ...newSessionPayload('epoch-1', NOW), v: 3 };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = sign(body);
    expect(verifySessionSignature(token, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a payload with no epoch', () => {
    const { v, iat, exp } = newSessionPayload('epoch-1', NOW);
    const body = Buffer.from(JSON.stringify({ v, iat, exp })).toString('base64url');
    expect(verifySessionSignature(sign(body), NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an unknown kind', () => {
    const payload = { ...newSessionPayload('epoch-1', NOW), kind: 'plumber' };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(verifySessionSignature(sign(body), NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a client payload missing the account id', () => {
    const { v, iat, exp, epoch, kind, sid } = { ...newClientSessionPayload({ clientId: 'client-1', sid: 'sid-1', epoch: 'client-epoch-1' }, NOW) };
    const body = Buffer.from(JSON.stringify({ v, iat, exp, epoch, kind, sid })).toString('base64url');
    expect(verifySessionSignature(sign(body), NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a client payload missing the sid', () => {
    const { v, iat, exp, epoch, kind, clientId } = { ...newClientSessionPayload({ clientId: 'client-1', sid: 'sid-1', epoch: 'client-epoch-1' }, NOW) };
    const body = Buffer.from(JSON.stringify({ v, iat, exp, epoch, kind, clientId })).toString('base64url');
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
    currentClientEpoch.mockRejectedValue(new Error('should not be called'));
    await expect(verifySession('garbage')).resolves.toMatchObject({ ok: false });
    expect(currentEpoch).not.toHaveBeenCalled();
    expect(currentClientEpoch).not.toHaveBeenCalled();
  });

  it('verifies an operator cookie against the operator epoch', async () => {
    await expect(verifySession(mint('epoch-1'))).resolves.toMatchObject({ ok: true });
    expect(currentEpoch).toHaveBeenCalledTimes(1);
    expect(currentClientEpoch).not.toHaveBeenCalled();
  });

  it('verifies a client cookie against the account epoch', async () => {
    const result = await verifySession(mintClient());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.kind).toBe('client');
      expect(result.payload.clientId).toBe('client-1');
    }
    expect(currentClientEpoch).toHaveBeenCalledWith('client-1');
    expect(currentEpoch).not.toHaveBeenCalled();
  });

  it('rejects a client cookie bound to a revoked account epoch', async () => {
    // A password change or suspension moves the account epoch; the old cookie must
    // stop verifying even though its signature and expiry are intact.
    currentClientEpoch.mockResolvedValue('client-epoch-2');
    await expect(verifySession(mintClient())).resolves.toEqual({
      ok: false,
      reason: 'stale_epoch',
    });
  });

  it('fails closed for a client cookie when the session store is unreachable', async () => {
    currentClientEpoch.mockRejectedValue(new Error('redis down'));
    await expect(verifySession(mintClient())).resolves.toEqual({
      ok: false,
      reason: 'unavailable',
    });
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

  it('accepts a client cookie minted by the Node runtime', () => {
    const token = mintClient({ name: 'Ace Widgets' }, 'client-epoch-1', NOW);
    expect(verifySessionCookieShape(token, NOW)).toEqual({ ok: true });
  });

  it('rejects a signed, expired client cookie at the boundary', () => {
    const token = mintClient({}, 'client-epoch-1', NOW);
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

  it('rejects a client payload missing the account id or the sid', () => {
    const full = newClientSessionPayload({ clientId: 'client-1', sid: 'sid-1', epoch: 'client-epoch-1' }, NOW);
    for (const { sid, clientId } of [{ sid: 'sid-1' }, { clientId: 'client-1' }]) {
      const { v, iat, exp, epoch, kind } = full;
      const stripped = clientId ? { v, iat, exp, epoch, kind, clientId } : { v, iat, exp, epoch, kind, sid };
      const body = Buffer.from(JSON.stringify(stripped)).toString('base64url');
      expect(verifySessionCookieShape(`${body}.sig`, NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
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

function payloadOf(token: string): { v: number; iat: number; exp: number; epoch: string; kind: string } {
  return JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
}
