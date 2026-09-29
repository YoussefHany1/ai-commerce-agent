import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const currentEpoch = vi.fn<() => Promise<string>>();
const currentClientEpoch = vi.fn<(clientId: string) => Promise<string>>();
const currentOperatorEpoch = vi.fn<(operatorId: string) => Promise<string>>();

// Only the Redis reads are stubbed; everything under test is the real implementation.
vi.mock('./redis', () => ({ currentEpoch, currentClientEpoch, currentOperatorEpoch }));

const SECRET = 'a'.repeat(48);

// The two operator epochs are deliberately different values: a test that passed with
// one number standing in for both could not tell a per-person revocation from a blanket
// one, which is precisely the distinction the dual-epoch design exists to make.
const OP_EPOCH = 'op-epoch-1';
const GLOBAL_EPOCH = 'global-epoch-1';
const OP_TTL = 12 * 60 * 60;

const {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  newClientSessionPayload,
  newOperatorSessionPayload,
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

function operatorPayload(
  input: { operatorId?: string; sid?: string; epoch?: string; globalEpoch?: string; expiresIn?: number } = {},
  now = NOW,
) {
  return newOperatorSessionPayload(
    {
      operatorId: input.operatorId ?? 'operator-1',
      sid: input.sid ?? 'op-sid-1',
      epoch: input.epoch ?? OP_EPOCH,
      globalEpoch: input.globalEpoch ?? GLOBAL_EPOCH,
      expiresIn: input.expiresIn ?? OP_TTL,
    },
    now,
  );
}

function clientPayload(
  input: { clientId?: string; sid?: string; epoch?: string; expiresIn?: number; name?: string; email?: string } = {},
  now = NOW,
) {
  return newClientSessionPayload(
    {
      clientId: input.clientId ?? 'client-1',
      sid: input.sid ?? 'sid-1',
      epoch: input.epoch ?? 'client-epoch-1',
      expiresIn: input.expiresIn ?? OP_TTL,
      name: input.name,
      email: input.email,
    },
    now,
  );
}

function mint(input: Parameters<typeof operatorPayload>[0] = {}, now = NOW): string {
  return serializeSession(operatorPayload(input, now));
}

function mintClient(
  input: Parameters<typeof clientPayload>[0] = {},
  now = NOW,
): string {
  return serializeSession(clientPayload(input, now));
}

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  currentEpoch.mockReset();
  currentEpoch.mockResolvedValue(GLOBAL_EPOCH);
  currentClientEpoch.mockReset();
  currentClientEpoch.mockResolvedValue('client-epoch-1');
  currentOperatorEpoch.mockReset();
  currentOperatorEpoch.mockResolvedValue(OP_EPOCH);
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.SESSION_COOKIE_SECURE;
  vi.unstubAllEnvs();
});

describe('serializeSession', () => {
  it('produces a payload.signature pair with no padding characters', () => {
    expect(mint()).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('mints an operator payload the reader can round-trip', () => {
    const token = mint({}, NOW);
    expect(token.split('.')).toHaveLength(2);
    const result = verifySessionSignature(token, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.kind).toBe('operator');
      expect(result.payload.operatorId).toBe('operator-1');
      expect(result.payload.sid).toBe('op-sid-1');
      expect(result.payload.epoch).toBe(OP_EPOCH);
      expect(result.payload.globalEpoch).toBe(GLOBAL_EPOCH);
      expect(result.payload.exp * 1000 - result.payload.iat * 1000).toBe(OP_TTL * 1000);
    }
  });

  it('mints a client payload carrying the account id and sid', () => {
    const token = mintClient({ name: 'Ace Widgets', email: 'a@example.com' }, NOW);
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

  it('never sets operator fields on a client payload, or the reverse', () => {
    // The reader refuses a mixed payload, so the writers must not produce one.
    const client = clientPayload();
    expect(client.operatorId).toBeUndefined();
    expect(client.globalEpoch).toBeUndefined();
    const operator = operatorPayload();
    expect(operator.clientId).toBeUndefined();
  });

  it('takes the lifetime from the caller so the cookie tracks the API record', () => {
    // The API's Redis TTL is the real deadline; a local constant that outlasts it
    // produces a signed-in-but-refused loop after a config change on the other service.
    const result = verifySessionSignature(mintClient({ expiresIn: 90 }), NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.exp - result.payload.iat).toBe(90);
  });
});

describe('verifySessionSignature', () => {
  it('rejects a missing cookie', () => {
    expect(verifySessionSignature(undefined)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an unsigned cookie', () => {
    const body = Buffer.from(JSON.stringify(operatorPayload())).toString('base64url');
    expect(verifySessionSignature(body)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a tampered payload', () => {
    const [body, signature] = mint().split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...operatorPayload(), epoch: 'attacker' }),
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
    const token = mint();
    // Read the real expiry rather than recomputing it: `iat` is truncated to whole
    // seconds, so NOW + TTL is up to a second past the true boundary.
    const exp = payloadOf(token).exp * 1000;
    expect(verifySessionSignature(token, exp - 1).ok).toBe(true);
    expect(verifySessionSignature(token, exp)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a payload from a future format version', () => {
    // A payload this service cannot interpret must not be honoured on the assumption
    // that its fields are a superset of what it expects.
    const payload = { ...operatorPayload(), v: 4 };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(verifySessionSignature(sign(body), NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a payload from a superseded version', () => {
    // v2 described an operator as a bare epoch with no identity — the shape a shared
    // password needed. Honouring it would authenticate nobody in particular, which is
    // what v3 replaced.
    const payload = { ...operatorPayload(), v: 2 };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(verifySessionSignature(sign(body), NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a payload with no epoch', () => {
    const { v, iat, exp } = operatorPayload();
    const body = Buffer.from(JSON.stringify({ v, iat, exp })).toString('base64url');
    expect(verifySessionSignature(sign(body), NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an unknown kind', () => {
    const payload = { ...operatorPayload(), kind: 'plumber' };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(verifySessionSignature(sign(body), NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a payload with no sid, whichever kind it claims', () => {
    for (const payload of [operatorPayload(), clientPayload()]) {
      const stripped: Record<string, unknown> = { ...payload };
      delete stripped.sid;
      const body = Buffer.from(JSON.stringify(stripped)).toString('base64url');
      expect(verifySessionSignature(sign(body), NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('rejects a client payload missing the account id', () => {
    const payload = clientPayload({ clientId: '' });
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(verifySessionSignature(sign(body), NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a client payload missing the sid', () => {
    const payload = clientPayload({ sid: '' });
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(verifySessionSignature(sign(body), NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an operator payload missing its identity', () => {
    const payload = operatorPayload({ operatorId: '' });
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(verifySessionSignature(sign(body), NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an operator payload missing the install-wide epoch', () => {
    // Without it a targeted per-person revocation could be laundered by holding a
    // matching per-person epoch, and `revoke-all` would stop meaning "all".
    const payload = operatorPayload({ globalEpoch: '' });
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(verifySessionSignature(sign(body), NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects a payload whose fields contradict its own kind', () => {
    for (const payload of [
      { ...clientPayload(), globalEpoch: GLOBAL_EPOCH },
      { ...clientPayload(), operatorId: 'operator-1' },
      { ...operatorPayload(), clientId: 'client-1' },
    ]) {
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      expect(verifySessionSignature(sign(body), NOW)).toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });
});

describe('verifySession', () => {
  it('accepts a cookie bound to the current epoch', async () => {
    await expect(verifySession(mint())).resolves.toMatchObject({ ok: true });
  });

  it('rejects a cookie issued before the last global revocation', async () => {
    // This is the path that makes `revoke-operator-sessions` effective for everyone.
    currentEpoch.mockResolvedValue('global-epoch-2');
    await expect(verifySession(mint())).resolves.toEqual({
      ok: false,
      reason: 'stale_epoch',
    });
  });

  it('rejects a cookie after that one operator was revoked, with the global epoch intact', async () => {
    // The other direction of the pair: the install-wide epoch is unchanged, so only the
    // per-person check can catch a targeted revocation.
    currentOperatorEpoch.mockResolvedValue('op-epoch-2');
    await expect(verifySession(mint())).resolves.toEqual({
      ok: false,
      reason: 'stale_epoch',
    });
  });

  it('fails closed when the session store is unreachable', async () => {
    currentEpoch.mockRejectedValue(new Error('redis down'));
    await expect(verifySession(mint())).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('fails closed when only the per-operator lookup fails', async () => {
    // A partial outage of the lookup that guards one person must not read as "epoch
    // matches" and let that person through.
    currentOperatorEpoch.mockRejectedValue(new Error('redis down'));
    await expect(verifySession(mint())).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });

  it('does not reach for the session store when the signature is already bad', async () => {
    currentEpoch.mockRejectedValue(new Error('should not be called'));
    currentClientEpoch.mockRejectedValue(new Error('should not be called'));
    currentOperatorEpoch.mockRejectedValue(new Error('should not be called'));
    await expect(verifySession('garbage')).resolves.toMatchObject({ ok: false });
    expect(currentEpoch).not.toHaveBeenCalled();
    expect(currentClientEpoch).not.toHaveBeenCalled();
    expect(currentOperatorEpoch).not.toHaveBeenCalled();
  });

  it('verifies an operator cookie against both of its epochs', async () => {
    await expect(verifySession(mint())).resolves.toMatchObject({ ok: true });
    expect(currentOperatorEpoch).toHaveBeenCalledWith('operator-1');
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
    // A client has no install-wide epoch; consulting it would tie a merchant's session
    // to an operator-side kill switch it has nothing to do with.
    expect(currentEpoch).not.toHaveBeenCalled();
    expect(currentOperatorEpoch).not.toHaveBeenCalled();
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

  it('defaults to the fallback lifetime, which sign-in never uses', () => {
    // Sign-in always passes the API's figure; the default exists for the specs and for
    // a hand-minted cookie, so it is asserted rather than left implicit.
    expect(sessionCookieOptions().maxAge).toBe(SESSION_TTL_SECONDS);
    expect(sessionCookieOptions(60).maxAge).toBe(60);
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
    const token = mintClient({ name: 'Ace Widgets' }, NOW);
    expect(verifySessionCookieShape(token, NOW)).toEqual({ ok: true });
  });

  it('rejects a signed, expired client cookie at the boundary', () => {
    const token = mintClient({}, NOW);
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
    const full = clientPayload();
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

  it('applies the operator rules on the Edge path too', () => {
    // Middleware runs here, so if the shape check were laxer than the Node reader the
    // login redirect would disagree with the proxy about who is signed in.
    for (const payload of [
      operatorPayload({ globalEpoch: '' }),
      operatorPayload({ operatorId: '' }),
      { ...clientPayload(), globalEpoch: GLOBAL_EPOCH },
    ]) {
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
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
