import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'c'.repeat(48);

// next/headers is mocked globally so every call site (this helper and the BFF
// routes) shares the in-memory cookie store; `mintClientSessionCookie` writes
// `aca_session` into it exactly as a unit test can observe.
type Cookie = { name: string; value: string; options: Record<string, unknown> };
let cookieStore: {
  written: Cookie[];
  set: (name: string, value: string, options: Record<string, unknown>) => void;
  getAll: () => never[];
};

vi.mock('next/headers', () => ({
  cookies: () => cookieStore,
}));

const {
  callClientAuth,
  mintClientSessionCookie,
  safeNext,
} = await import('./clientExchange');

function makeStore() {
  const written: Cookie[] = [];
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
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(String(input), init ?? {});
  }));
}

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET;
  process.env.API_URL = 'http://upstream.test/';
  cookieStore = makeStore();
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.API_URL;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('callClientAuth', () => {
  it('strips trailing slashes from the configured API base', async () => {
    stubFetch((url) => {
      expect(url).toBe('http://upstream.test/api/auth/client/exchange');
      return jsonResponse({ ok: true });
    });
    const out = await callClientAuth('exchange', { accessToken: 't' });
    expect(out.status).toBe(200);
  });

  it('fails closed with 503 when no API_URL is configured', async () => {
    delete process.env.API_URL;
    const out = await callClientAuth('forgot', { email: 'a@b.c' });
    expect(out).toEqual({ status: 503, payload: { error: 'upstream_not_configured' } });
  });

  it('maps a network failure to 502 upstream_unreachable', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const out = await callClientAuth('register', { name: 'N', email: 'a@b.c', password: 'x'.repeat(12) });
    expect(out.status).toBe(502);
    expect(out.payload.error).toBe('upstream_unreachable');
  });

  it('relays the upstream status, code and payload untouched', async () => {
    stubFetch(() => jsonResponse({ error: 'invalid_credentials' }, 401));
    const out = await callClientAuth('exchange', { accessToken: 'bad' });
    expect(out).toEqual({ status: 401, payload: { error: 'invalid_credentials' } });
  });

  it('tolerates a non-JSON upstream body', async () => {
    stubFetch(() => new Response('oops', { status: 500 }));
    const out = await callClientAuth('forgot', { email: 'a@b.c' });
    expect(out.status).toBe(500);
    expect(out.payload).toEqual({});
  });
});

describe('mintClientSessionCookie', () => {
  it('writes a v2 client session cookie from a complete exchange payload', async () => {
    const ok = await mintClientSessionCookie({
      clientId: 'client-1',
      sid: 'sid-1',
      epoch: 'epoch-1',
      name: 'Nadia',
      email: 'n@b.c',
    });
    expect(ok).toBe(true);
    expect(cookieStore.written).toHaveLength(1);
    const [cookie] = cookieStore.written;
    expect(cookie.name).toBe('aca_session');
    expect(cookie.options.httpOnly).toBe(true);
    expect(String(cookie.options.path)).toBe('/');
    const [body, sig] = cookie.value.split('.');
    expect(body).toBeTruthy();
    expect(sig).toBeTruthy();
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    expect(payload.v).toBe(2);
    expect(payload.kind).toBe('client');
    expect(payload.clientId).toBe('client-1');
    expect(payload.sid).toBe('sid-1');
    expect(payload.epoch).toBe('epoch-1');
  });

  it('refuses (returns false) when the exchange response is not a session', async () => {
    const ok = await mintClientSessionCookie({ ok: true });
    expect(ok).toBe(false);
    expect(cookieStore.written).toHaveLength(0);
  });
});

describe('safeNext', () => {
  it('only allows same-origin absolute paths', () => {
    expect(safeNext('/dashboard/stores')).toBe('/dashboard/stores');
    expect(safeNext('/login')).toBe('/login');
    expect(safeNext(null)).toBeNull();
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext('')).toBeNull();
    expect(safeNext('dashboard')).toBeNull();
    expect(safeNext('//evil.test')).toBeNull();
    expect(safeNext('/\\evil')).toBe('/\\evil');
  });
});