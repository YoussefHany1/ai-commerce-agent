import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';

// The route handlers (and this module) use `server-only`, which throws when imported
// outside a React Server Component graph. Stubbing the module specifier is what lets
// the session-minting logic be asserted directly in a plain unit test.
vi.mock('server-only', () => ({}));

// An in-memory cookie jar: `cookies()` is mocked, and several route handlers
// (login/exchange/reset) share the same module instance in a real app, so they share
// this store in the test too.
const jar = new Map<string, string>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { SESSION_COOKIE, verifySession, isSessionPayload } = await import('./session');
const { callAuthApi, mintSessionCookie, buildPayload, authApiBase, safeNext } = await import('./authExchange');
type AuthApiResponse = import('./authExchange').AuthApiResponse;

const ORIGINAL_ENV = { ...process.env };
const HOUR = 3600;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** A well-formed client answer, as `/api/auth/exchange` returns for a merchant. */
const clientAnswer = {
  ok: true,
  kind: 'client' as const,
  clientId: 'c1',
  name: 'Ace',
  email: 'ace@example.com',
  sid: 'sid-client',
  epoch: 'ep-client',
  expiresIn: HOUR,
};

/** The same, for an operator — note the second epoch and no clientId. */
const operatorAnswer = {
  ok: true,
  kind: 'operator' as const,
  operatorId: 'o1',
  name: 'Youssef',
  email: 'youssef@example.com',
  sid: 'sid-operator',
  epoch: 'ep-operator',
  globalEpoch: 'ep-global',
  expiresIn: 2 * HOUR,
};

beforeEach(() => {
  jar.clear();
  fetchMock.mockReset();
  process.env.API_URL = 'http://upstream.test/';
  process.env.SESSION_SECRET = 's'.repeat(32);
  process.env.REDIS_URL = 'redis://localhost:6379';
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('authApiBase', () => {
  it('trims trailing slashes so paths do not double up', () => {
    process.env.API_URL = 'http://upstream.test///';
    expect(authApiBase()).toBe('http://upstream.test');
  });

  it('is null when unset, which callers turn into a 503', () => {
    delete process.env.API_URL;
    expect(authApiBase()).toBeNull();
  });
});

describe('callAuthApi', () => {
  it('posts to the kind-neutral exchange path', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, clientAnswer));
    const out = await callAuthApi('exchange', { accessToken: 't' });
    expect(out.status).toBe(200);
    expect(out.payload).toMatchObject({ kind: 'client' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://upstream.test/api/auth/exchange');
  });

  it('posts to the operator login path', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, operatorAnswer));
    await callAuthApi('operator/login', { email: 'a@b.c', password: 'x' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://upstream.test/api/auth/operator/login');
  });

  it('reports a missing API_URL as 503 rather than throwing', async () => {
    delete process.env.API_URL;
    const out = await callAuthApi('exchange', { accessToken: 't' });
    expect(out.status).toBe(503);
    expect(out.payload).toEqual({ error: 'upstream_not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an unreachable upstream as 502', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await callAuthApi('exchange', { accessToken: 't' });
    expect(out.status).toBe(502);
    expect(out.payload).toEqual({ error: 'upstream_unreachable' });
  });

  it('tolerates a non-JSON upstream body instead of throwing', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    const out = await callAuthApi('exchange', { accessToken: 't' });
    expect(out.status).toBe(502);
    expect(out.payload).toEqual({});
  });

  it('forwards extra headers, which is how a session is presented on logout', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await callAuthApi('logout', {}, { 'x-operator-session': 'sid-1' });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ 'x-operator-session': 'sid-1' });
  });
});

describe('buildPayload', () => {
  it('builds a client payload from a client answer', () => {
    const built = buildPayload(clientAnswer);
    expect(built).not.toBeNull();
    expect(built!.expiresIn).toBe(HOUR);
    expect(built!.payload).toMatchObject({
      kind: 'client',
      clientId: 'c1',
      sid: 'sid-client',
      epoch: 'ep-client',
      name: 'Ace',
    });
  });

  it('builds an operator payload carrying both epochs and the identity', () => {
    const built = buildPayload(operatorAnswer);
    expect(built).not.toBeNull();
    expect(built!.payload).toMatchObject({
      kind: 'operator',
      operatorId: 'o1',
      sid: 'sid-operator',
      epoch: 'ep-operator',
      globalEpoch: 'ep-global',
      name: 'Youssef',
    });
  });

  it('refuses when the answer names no kind', () => {
    // The field that distinguishes a merchant from an administrator must never be
    // inferred: guessing is how one becomes the other.
    expect(buildPayload({ ...clientAnswer, kind: undefined })).toBeNull();
  });

  it('refuses an operator answer missing its global epoch', () => {
    const { globalEpoch: _dropped, ...rest } = operatorAnswer;
    expect(buildPayload(rest)).toBeNull();
  });

  it('drops stray operator fields from a client answer rather than carrying them through', () => {
    // `isSessionPayload` refuses a client payload holding `globalEpoch`/`operatorId`,
    // so a builder that copied them across would mint a cookie the proxy then rejects on
    // every request. Ignoring fields that kind does not use is what keeps that pair
    // consistent.
    const built = buildPayload({ ...clientAnswer, globalEpoch: 'ep-global', operatorId: 'o1' });
    expect(built).not.toBeNull();
    expect(built!.payload.globalEpoch).toBeUndefined();
    expect(built!.payload.operatorId).toBeUndefined();
    expect(isSessionPayload(built!.payload)).toBe(true);
  });

  it('refuses a partial answer rather than defaulting the missing field', () => {
    for (const drop of ['sid', 'epoch', 'expiresIn', 'clientId'] as const) {
      const partial: Record<string, unknown> = { ...clientAnswer };
      delete partial[drop];
      expect(buildPayload(partial)).toBeNull();
    }
  });

  it('refuses a non-positive lifetime, which would write a cookie that never expires', () => {
    expect(buildPayload({ ...clientAnswer, expiresIn: 0 })).toBeNull();
    expect(buildPayload({ ...clientAnswer, expiresIn: -1 })).toBeNull();
  });

  it('ignores a name or email that is not a string', () => {
    // An unexpected type means the upstream answered something we do not model; the
    // builder drops those fields rather than writing an object the shell would render.
    const built = buildPayload({ ...clientAnswer, name: 42, email: null } as unknown as AuthApiResponse);
    expect(built!.payload.name).toBeUndefined();
    expect(built!.payload.email).toBeUndefined();
  });
});

describe('mintSessionCookie', () => {
  it('writes an HTTP-only cookie for whichever kind came back', async () => {
    expect(await mintSessionCookie(operatorAnswer)).toBe(true);
    const raw = jar.get(SESSION_COOKIE)!;
    const payload = JSON.parse(Buffer.from(raw.split('.')[0], 'base64url').toString('utf8'));
    expect(isSessionPayload(payload)).toBe(true);
    expect(payload.kind).toBe('operator');
    expect(payload.operatorId).toBe('o1');
  });

  it('writes nothing when the answer is not a complete session', async () => {
    expect(await mintSessionCookie({ ok: true })).toBe(false);
    expect(jar.has(SESSION_COOKIE)).toBe(false);
  });

  it('binds the cookie lifetime to the API answer, not a local constant', async () => {
    // The cookie must never outlive the Redis record behind it, or the user lands in a
    // loop of "signed in" cookies the API refuses.
    await mintSessionCookie({ ...operatorAnswer, expiresIn: 90 });
    const raw = jar.get(SESSION_COOKIE)!;
    const payload = JSON.parse(Buffer.from(raw.split('.')[0], 'base64url').toString('utf8'));
    expect(payload.exp - payload.iat).toBe(90);
  });
});

describe('safeNext', () => {
  it('accepts same-origin paths', () => {
    expect(safeNext('/dashboard')).toBe('/dashboard');
  });

  it('refuses absolute, protocol-relative and empty targets', () => {
    for (const value of ['https://evil.test', '//evil.test', '', null, undefined]) {
      expect(safeNext(value)).toBeNull();
    }
  });
});
