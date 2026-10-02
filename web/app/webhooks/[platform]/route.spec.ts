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

import { POST, GET } from './route';

const params = (platform: string) => ({ params: Promise.resolve({ platform }) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(Response.json({ ok: true }, { status: 200 }));
});

afterEach(() => vi.unstubAllGlobals());

describe('POST /webhooks/[platform]', () => {
  test('forwards the payload byte-for-byte so the platform HMAC still verifies', async () => {
    // Whitespace and key order are part of what Shopify signed.
    const raw = '{"order_number":1001,  "note":"keep  spacing",\n  "b":2}';
    const req = new Request('http://localhost:3001/webhooks/shopify?x=1', {
      method: 'POST',
      body: raw,
      headers: { 'content-type': 'application/json', 'x-shopify-hmac-sha256': 'sig-abc' },
    });
    const res = await POST(req, params('shopify'));

    const [, init] = fetchMock.mock.calls[0]!;
    // Not merely equivalent JSON: the identical string, so the digest matches.
    expect(init!.body).toBe(raw);
    expect((init!.headers as Record<string, string>)['x-shopify-hmac-sha256']).toBe('sig-abc');
    expect(res.status).toBe(200);
  });

  test('relays to the API webhooks path and preserves the query string', async () => {
    await POST(
      new Request('http://localhost:3001/webhooks/salla?tenant=7', { method: 'POST', body: '{}' }),
      params('salla'),
    );
    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://api.test/webhooks/salla?tenant=7');
  });

  test('forwards the topic and shop domain, not just the signature', async () => {
    // The regression: only the HMAC was relayed. The API identifies an event by
    // `x-shopify-topic` and resolves the store by `x-shopify-shop-domain`, 404ing on
    // `store_not_found` without the latter. So every webhook arrived as an unknown-topic
    // event for no store, and `app/uninstalled` never reached the handler that deletes the
    // store — which is why a store deleted in Shopify still read as connected.
    await POST(
      new Request('http://localhost:3001/webhooks/shopify', {
        method: 'POST',
        body: '{}',
        headers: {
          'content-type': 'application/json',
          'x-shopify-hmac-sha256': 'sig-abc',
          'x-shopify-topic': 'app/uninstalled',
          'x-shopify-shop-domain': 'demo.myshopify.com',
          'x-shopify-webhook-id': 'wh-1',
        },
      }),
      params('shopify'),
    );

    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['x-shopify-topic']).toBe('app/uninstalled');
    expect(headers['x-shopify-shop-domain']).toBe('demo.myshopify.com');
    expect(headers['x-shopify-webhook-id']).toBe('wh-1');
  });

  test('sends no session credential — the HMAC is the authenticator', async () => {
    await POST(
      new Request('http://localhost:3001/webhooks/shopify', { method: 'POST', body: '{}' }),
      params('shopify'),
    );
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['x-client-session']).toBeUndefined();
    expect(headers['x-operator-session']).toBeUndefined();
    expect(headers['cookie']).toBeUndefined();
  });

  test('rejects a non-platform path segment', async () => {
    const res = await POST(
      new Request('http://localhost:3001/webhooks/shopify', { method: 'POST', body: '{}' }),
      params('../../etc'),
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('answers a reachability probe locally instead of relaying it', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
