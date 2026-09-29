import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'd'.repeat(48);

// Shared cookie store seen by every `cookies()` call (the route mints the session
// cookie through next/headers).
let cookieStore: { written: Array<{ name: string; value: string; options: Record<string, unknown> }> };

vi.mock('next/headers', () => ({
  cookies: () => cookieStore,
}));

const { POST } = await import('./route');

function makeStore() {
  const written: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  return {
    written,
    set: (name: string, value: string, options: Record<string, unknown>) => {
      written.push({ name, value, options });
    },
    getAll: () => [],
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init ?? {}),
  ));
}

function post(body: unknown): Promise<Response> {
  return POST(new Request('http://app.test/api/auth/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  process.env.API_URL = 'http://upstream.test';
  cookieStore = makeStore();
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.API_URL;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST /api/auth/exchange', () => {
  it('rejects a missing or oversized access token', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ accessToken: 7 })).status).toBe(400);
    expect((await post({ accessToken: 'x'.repeat(9000) })).status).toBe(400);
  });

  it('fails closed with 503 when the API base is not configured', async () => {
    delete process.env.API_URL;
    const res = await post({ accessToken: 'live-token' });
    expect(res.status).toBe(503);
  });

  it('relays an upstream rejection unchanged', async () => {
    stubFetch(() => jsonResponse({ error: 'invalid_credentials' }, 401));
    const res = await post({ accessToken: 'bad' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
    expect(cookieStore.written).toHaveLength(0);
  });

  it('mints the session cookie from a successful exchange', async () => {
    stubFetch(() =>
      jsonResponse({
        ok: true,
        kind: 'client',
        clientId: 'client-1',
        sid: 'sid-1',
        epoch: 'epoch-1',
        expiresIn: 3600,
        name: 'Nadia',
        email: 'n@b.c',
      }),
    );
    const res = await post({ accessToken: 'live-token' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kind: 'client' });
    expect(cookieStore.written).toHaveLength(1);
    expect(cookieStore.written[0].name).toBe('aca_session');
    const payload = JSON.parse(Buffer.from(cookieStore.written[0].value.split('.')[0], 'base64url').toString('utf8'));
    expect(payload.kind).toBe('client');
    expect(payload.clientId).toBe('client-1');
    expect(payload.sid).toBe('sid-1');
  });

  it('mints an operator cookie carrying both epochs, without being told which to mint', async () => {
    // The request never states a kind. The same Google button serves an operator and a
    // merchant, so the API's answer is the only thing that may decide.
    stubFetch(() =>
      jsonResponse({
        ok: true,
        kind: 'operator',
        operatorId: 'op-1',
        sid: 'op-sid-1',
        epoch: 'op-epoch-1',
        globalEpoch: 'global-epoch-1',
        expiresIn: 3600,
        name: 'Youssef',
        email: 'y@example.com',
      }),
    );
    const res = await post({ accessToken: 'live-token' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, kind: 'operator' });
    const payload = JSON.parse(Buffer.from(cookieStore.written[0].value.split('.')[0], 'base64url').toString('utf8'));
    expect(payload).toMatchObject({
      kind: 'operator',
      operatorId: 'op-1',
      sid: 'op-sid-1',
      epoch: 'op-epoch-1',
      globalEpoch: 'global-epoch-1',
    });
  });

  it('refuses an answer that names no kind rather than assuming one', async () => {
    // Inferring the kind is how a merchant ends up holding an operator cookie, or an
    // operator quietly gets the client surface.
    stubFetch(() => jsonResponse({ ok: true, clientId: 'client-1', sid: 'sid-1', epoch: 'epoch-1', expiresIn: 3600 }));
    const res = await post({ accessToken: 'live-token' });
    expect(res.status).toBe(503);
    expect(cookieStore.written).toHaveLength(0);
  });

  it('only rotates for a strict boolean', async () => {
    // A truthy string from an untrusted caller must not be able to bump somebody's
    // epoch and sign every other device out.
    for (const rotate of ['true', 1, 'yes']) {
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ ok: true, kind: 'client', clientId: 'c1', sid: 's1', epoch: 'e1', expiresIn: 3600 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      await post({ accessToken: 'live-token', rotate });
      const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
      expect(body.rotate).toBeUndefined();
    }
  });

  it('passes rotate through when the reset flow asks for it', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ ok: true, kind: 'client', clientId: 'c1', sid: 's1', epoch: 'e2', expiresIn: 3600 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await post({ accessToken: 'live-token', rotate: true });
    expect(res.status).toBe(200);
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({
      accessToken: 'live-token',
      rotate: true,
    });
  });

  it('fails closed when the exchange claims success without a session', async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const res = await post({ accessToken: 'live-token' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'auth_unavailable' });
    expect(cookieStore.written).toHaveLength(0);
  });
});