import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { verifyStoreCredentials } from './factory.js';

vi.mock('../db/repos.js', () => ({
  connectionRepo: { get: vi.fn(), refreshIfExpired: vi.fn(), decryptToken: vi.fn() },
  storeRepo: { get: vi.fn(), getSecret: vi.fn() },
}));

/** Minimal fetch double: records the calls and replays queued responses. */
function stubFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.body,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyStoreCredentials', () => {
  test('rejects a Shopify store with no shop domain before making any call', async () => {
    const calls = stubFetch([{ body: {} }]);
    const res = await verifyStoreCredentials({ platform: 'shopify', accessToken: 'shpat_x' });
    expect(res).toMatchObject({ ok: false, code: 'missing_shop_domain' });
    expect(calls).toHaveLength(0);
  });

  test('accepts a valid Shopify token with a single shop query', async () => {
    const calls = stubFetch([{ body: { data: { shop: { name: 'Demo' } } } }]);
    const res = await verifyStoreCredentials({
      platform: 'shopify',
      shopDomain: 'demo.myshopify.com',
      accessToken: 'shpat_ok',
    });
    expect(res).toEqual({ ok: true });
    // One round trip, and it asks for the shop rather than a page of products.
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.url)).toContain('demo.myshopify.com');
    expect(JSON.parse(String(calls[0]!.init.body)).query).toContain('shop');
  });

  test('reports a rejected Shopify token as unreachable with the platform text', async () => {
    stubFetch([{ status: 401, body: { errors: 'Invalid API key or access token' } }]);
    const res = await verifyStoreCredentials({
      platform: 'shopify',
      shopDomain: 'demo.myshopify.com',
      accessToken: 'shpat_bad',
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.code).toBe('unreachable');
    expect(res.message).toMatch(/401/);
  });

  test('never throws on a platform failure, so the caller can map it to a 4xx', async () => {
    stubFetch([{ status: 500, body: {} }]);
    await expect(
      verifyStoreCredentials({ platform: 'shopify', shopDomain: 'demo.myshopify.com', accessToken: 'x' }),
    ).resolves.toMatchObject({ ok: false });
  });

  test('refuses a manual Zid store, which has no way to obtain zidAuthorization', async () => {
    const calls = stubFetch([{ body: {} }]);
    const res = await verifyStoreCredentials({ platform: 'zid', accessToken: 'zid_tok' });
    expect(res).toMatchObject({ ok: false, code: 'zid_requires_oauth' });
    expect(calls).toHaveLength(0);
  });

  test('accepts a valid Salla token', async () => {
    const calls = stubFetch([{ body: { success: true, data: [] } }]);
    const res = await verifyStoreCredentials({ platform: 'salla', accessToken: 'salla_tok' });
    expect(res).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });

  test('rejects a Salla token the API refuses', async () => {
    stubFetch([{ status: 401, body: { success: false, message: 'invalid token' } }]);
    const res = await verifyStoreCredentials({ platform: 'salla', accessToken: 'bad' });
    expect(res.ok).toBe(false);
  });
});
