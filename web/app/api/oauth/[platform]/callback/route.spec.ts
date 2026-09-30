import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
process.env.API_URL = 'http://api.test';

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

const params = (platform: string) => ({ params: Promise.resolve({ platform }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('GET /api/oauth/[platform]/callback', () => {
  test('follows the upstream redirect back to the dashboard', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://localhost:3001/dashboard/stores' },
      }),
    );
    const res = await GET(
      new Request('http://localhost:3001/api/oauth/shopify/callback?code=abc&state=s1&hmac=h'),
      params('shopify'),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:3001/dashboard/stores');
  });

  test('asks fetch not to follow the redirect, so the session cookie survives', async () => {
    // Without this the mocked 302 above is unrepresentative: a real fetch follows it
    // server-side, the browser receives neither the Location nor the Set-Cookie that
    // mints the session, and the install silently ends up logged out.
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://localhost:3001/dashboard' } }),
    );
    await GET(
      new Request('http://localhost:3001/api/oauth/shopify/callback?code=abc'),
      params('shopify'),
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' });
  });

  test('relays the code, state and hmac verbatim', async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true, storeId: 's' }));
    await GET(
      new Request('http://localhost:3001/api/oauth/shopify/callback?code=abc&state=s1&hmac=h&shop=demo.myshopify.com'),
      params('shopify'),
    );
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url.startsWith('http://api.test/api/oauth/shopify/callback?')).toBe(true);
    expect(url).toContain('code=abc');
    expect(url).toContain('state=s1');
    expect(url).toContain('hmac=h');
    expect(url).toContain('shop=demo.myshopify.com');
  });

  test('surfaces a rejected install rather than redirecting as if it worked', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'shop_already_connected' }, { status: 409 }));
    const res = await GET(
      new Request('http://localhost:3001/api/oauth/shopify/callback?code=abc&state=s1&hmac=h'),
      params('shopify'),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'shop_already_connected' });
  });

  test('reports an unreachable API as 502', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await GET(
      new Request('http://localhost:3001/api/oauth/shopify/callback?code=abc'),
      params('shopify'),
    );
    expect(res.status).toBe(502);
  });

  test('rejects a non-platform path segment', async () => {
    const res = await GET(
      new Request('http://localhost:3001/api/oauth/x/callback?code=a'),
      params('..%2Fadmin'),
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
