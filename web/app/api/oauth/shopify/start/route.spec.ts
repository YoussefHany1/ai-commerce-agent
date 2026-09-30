import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

const session = vi.hoisted(() => ({ ok: true, payload: { kind: 'client', sid: 'cli-1' } }));
const cookie = vi.hoisted(() => ({ value: 'cookie-token' as string | undefined }));
const fetchMock = vi.hoisted(() => vi.fn());

// `authApiBase()` reads this at call time; without it the route answers 503
// `upstream_not_configured` and every assertion below would pass vacuously.
process.env.API_URL = 'http://api.test';

vi.mock('next/headers', () => ({ cookies: () => ({ get: () => (cookie.value ? { value: cookie.value } : undefined) }) }));
vi.mock('@/lib/server/session', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  SESSION_COOKIE: 'aca_session',
  verifySession: vi.fn(async () => session),
}));
vi.mock('next/server', async (orig) => {
  const actual = await orig<typeof import('next/server')>();
  return {
    ...actual,
    NextResponse: {
      json: (body: unknown, init?: ResponseInit) => Response.json(body, init),
      redirect: (url: string, status = 302) =>
        new Response(null, { status, headers: { location: url } }),
    },
  };
});

import { GET } from './route';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  session.ok = true;
  session.payload = { kind: 'client', sid: 'cli-1' };
  cookie.value = 'cookie-token';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/oauth/shopify/start', () => {
  test('forwards a client session so the API can scope the new store', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://demo.myshopify.com/admin/oauth/authorize?state=abc' } }),
    );
    const res = await GET(new Request('http://localhost:3001/api/oauth/shopify/start?shop=demo.myshopify.com'));

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('state=abc');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/api/oauth/shopify/start?shop=demo.myshopify.com');
    const headers = init!.headers as Headers;
    expect(headers.get('x-client-session')).toBe('cli-1');
    expect(headers.get('x-operator-session')).toBeNull();
  });

  test('forwards an operator session in the operator header', async () => {
    session.payload = { kind: 'operator', sid: 'op-1' };
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://x/authorize' } }));
    await GET(new Request('http://localhost:3001/api/oauth/shopify/start?shop=demo.myshopify.com'));
    const headers = fetchMock.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get('x-operator-session')).toBe('op-1');
    expect(headers.get('x-client-session')).toBeNull();
  });

  test('refuses a stale session instead of starting an unauthenticated install', async () => {
    Object.assign(session, { ok: false, reason: 'expired' });
    const res = await GET(new Request('http://localhost:3001/api/oauth/shopify/start?shop=demo.myshopify.com'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'session_expired' });
    // Crucially: no upstream call, so no operator-scoped store can be created.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('surfaces a 503 when the session check itself is unavailable', async () => {
    Object.assign(session, { ok: false, reason: 'unavailable' });
    const res = await GET(new Request('http://localhost:3001/api/oauth/shopify/start?shop=demo.myshopify.com'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'auth_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('relays an upstream rejection body instead of a bare redirect', async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: 'invalid_redirect_after' }, { status: 400 }),
    );
    const res = await GET(new Request('http://localhost:3001/api/oauth/shopify/start?shop=demo.myshopify.com'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_redirect_after' });
  });
});
