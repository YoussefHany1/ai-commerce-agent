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
      jsonResponse({ ok: true, clientId: 'client-1', sid: 'sid-1', epoch: 'epoch-1', name: 'Nadia', email: 'n@b.c' }),
    );
    const res = await post({ accessToken: 'live-token' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(cookieStore.written).toHaveLength(1);
    expect(cookieStore.written[0].name).toBe('aca_session');
    const payload = JSON.parse(Buffer.from(cookieStore.written[0].value.split('.')[0], 'base64url').toString('utf8'));
    expect(payload.kind).toBe('client');
    expect(payload.clientId).toBe('client-1');
    expect(payload.sid).toBe('sid-1');
  });

  it('fails closed when the exchange claims success without a session', async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    const res = await post({ accessToken: 'live-token' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'auth_unavailable' });
    expect(cookieStore.written).toHaveLength(0);
  });
});