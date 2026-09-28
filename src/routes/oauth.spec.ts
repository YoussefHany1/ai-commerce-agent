import { test, expect, describe, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  byRef: vi.fn(),
  create: vi.fn(),
  setTokens: vi.fn(),
  updateSettings: vi.fn(),
  fetch: vi.fn(),
  warn: vi.fn(),
  config: {
    SHOPIFY_API_VERSION: '2025-07',
    APP_BASE_URL: 'https://app.example.com',
  },
}));

vi.mock('../db/repos.js', () => ({
  storeRepo: {
    byRef: mocks.byRef,
    create: mocks.create,
    updateSettings: mocks.updateSettings,
  },
  connectionRepo: { setTokens: mocks.setTokens },
  jobsRepo: { enqueue: mocks.enqueue },
}));
vi.mock('../lib/redis.js', () => ({ getRedis: async () => ({ incr: async () => 1, expire: async () => 1 }) }));
vi.mock('../lib/http.js', () => ({ fetchWithTimeout: (...a: unknown[]) => mocks.fetch(...a) }));
vi.mock('../lib/logger.js', () => ({ logger: { warn: mocks.warn, error: vi.fn(), info: vi.fn() } }));
vi.mock('../config.js', () => ({ config: mocks.config }));

function graphqlOk(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    async json() {
      return { data: { webhookSubscriptionCreate: { userErrors: [], ...extra } } };
    },
  };
}

async function load() {
  return import('../routes/oauth.js');
}

const NEW_STORE_ID = '11111111-2222-3333-4444-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enqueue.mockResolvedValue('job-1');
  mocks.byRef.mockResolvedValue(null);
  mocks.create.mockResolvedValue(NEW_STORE_ID);
  mocks.setTokens.mockResolvedValue(undefined);
  mocks.updateSettings.mockResolvedValue(undefined);
});

describe('registerShopifyWebhooks', () => {
  test('subscribes every analytics-critical topic with the shared callback', async () => {
    const seen: { topic: string; sub: { uri: string; format: string } }[] = [];
    mocks.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        variables: { topic: string; sub: { uri: string; format: string } };
        query: string;
      };
      seen.push(body.variables);
      expect(init.method).toBe('POST');
      // The mutation is singular: webhookSubscriptionCreate, not the plural form.
      expect(body.query).toContain('webhookSubscriptionCreate(');
      expect(body.query).not.toContain('webhookSubscriptionsCreate(');
      // `uri` is current; `callbackUrl` is deprecated on WebhookSubscriptionInput.
      expect(body.query).toContain('$sub:WebhookSubscriptionInput!');
      return graphqlOk();
    });

    const { registerShopifyWebhooks } = await load();
    const n = await registerShopifyWebhooks('demo.myshopify.com', 'tok');
    expect(n).toBe(6);
    expect(seen.map((s) => s.topic)).toEqual([
      'ORDERS_CREATE',
      'ORDERS_UPDATED',
      'ORDERS_CANCELLED',
      'PRODUCTS_CREATE',
      'PRODUCTS_UPDATE',
      'APP_UNINSTALLED',
    ]);
    for (const s of seen) {
      expect(s.sub.uri).toBe('https://app.example.com/webhooks/shopify');
      expect(s.sub.format).toBe('JSON');
    }
  });

  test('counts a duplicate subscription as already-registered instead of failing', async () => {
    mocks.fetch.mockResolvedValue(
      graphqlOk({ userErrors: [{ field: ['uri'], message: 'Address has already been taken' }] }),
    );
    const { registerShopifyWebhooks } = await load();
    // Re-installing must not look like a hard failure.
    await expect(registerShopifyWebhooks('demo.myshopify.com', 'tok')).resolves.toBe(6);
  });

  test('hits the shop-scoped admin GraphQL endpoint with the access token', async () => {
    let url = '';
    let headers: Record<string, string> | undefined;
    mocks.fetch.mockImplementation(async (u: string, init: RequestInit) => {
      url = u;
      headers = init.headers as Record<string, string>;
      return graphqlOk();
    });
    const { registerShopifyWebhooks } = await load();
    await registerShopifyWebhooks('demo.myshopify.com', 'shpat_x');
    expect(url).toBe('https://demo.myshopify.com/admin/api/2025-07/graphql.json');
    expect(headers?.['X-Shopify-Access-Token']).toBe('shpat_x');
  });

  test('surfaces a GraphQL top-level error rather than counting the topic as done', async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ errors: [{ message: 'Access denied' }] }) });
    const { registerShopifyWebhooks } = await load();
    await expect(registerShopifyWebhooks('demo.myshopify.com', 'tok')).rejects.toThrow(/Access denied/);
  });

  test('surfaces userErrors, which is where Shopify reports a rejected subscription', async () => {
    mocks.fetch.mockResolvedValue(
      graphqlOk({ userErrors: [{ field: ['callbackUrl'], message: 'Callback URL is not valid' }] }),
    );
    const { registerShopifyWebhooks } = await load();
    await expect(registerShopifyWebhooks('demo.myshopify.com', 'tok')).rejects.toThrow(/Callback URL is not valid/);
  });

  test('throws on a non-2xx response', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    const { registerShopifyWebhooks } = await load();
    await expect(registerShopifyWebhooks('demo.myshopify.com', 'tok')).rejects.toThrow(/401/);
  });
});

describe('saveInstall', () => {
  test('enqueues an immediate order backfill for a shopify install', async () => {
    mocks.fetch.mockResolvedValue(graphqlOk());
    const { saveInstall } = await load();
    await saveInstall({
      platform: 'shopify',
      name: 'Demo',
      shopDomain: 'demo.myshopify.com',
      accessToken: 'tok',
    });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    const [storeId, type] = mocks.enqueue.mock.calls[0] as [string, string];
    expect(type).toBe('order.sync');
    expect(storeId).toBe(NEW_STORE_ID);
  });

  test('does not fail the install when webhook registration fails', async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ errors: [{ message: 'nope' }] }) });
    const { saveInstall } = await load();
    await expect(
      saveInstall({ platform: 'shopify', name: 'Demo', shopDomain: 'demo.myshopify.com', accessToken: 'tok' }),
    ).resolves.toBe(NEW_STORE_ID);
    expect(mocks.warn).toHaveBeenCalled();
    // The backfill is still queued, so metrics do not depend on webhooks.
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  test('still enqueues when only the enqueue itself is unavailable', async () => {
    mocks.fetch.mockResolvedValue(graphqlOk());
    mocks.enqueue.mockRejectedValue(new Error('queue down'));
    const { saveInstall } = await load();
    await expect(
      saveInstall({ platform: 'shopify', name: 'Demo', shopDomain: 'demo.myshopify.com', accessToken: 'tok' }),
    ).resolves.toBe(NEW_STORE_ID);
  });

  test('reuses an existing store and refreshes its tokens on re-install', async () => {
    mocks.fetch.mockResolvedValue(graphqlOk());
    mocks.byRef.mockResolvedValue({ id: 'existing-store' });
    const { saveInstall } = await load();
    const id = await saveInstall({
      platform: 'shopify',
      name: 'Demo',
      shopDomain: 'demo.myshopify.com',
      accessToken: 'fresh-token',
    });
    expect(id).toBe('existing-store');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.setTokens).toHaveBeenCalledWith('existing-store', expect.objectContaining({ accessToken: 'fresh-token' }));
    expect(mocks.enqueue).toHaveBeenCalledWith('existing-store', 'order.sync', {}, expect.anything());
  });

  test('skips webhook registration for non-shopify platforms but still backfills', async () => {
    const { saveInstall } = await load();
    await saveInstall({ platform: 'salla', name: 'Salla', accessToken: 'tok' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect((mocks.enqueue.mock.calls[0] as unknown[])[1]).toBe('order.sync');
  });

  test('skips webhook registration when the shop domain is unknown', async () => {
    const { saveInstall } = await load();
    await saveInstall({ platform: 'shopify', name: 'Demo', shopDomain: null, accessToken: 'tok' });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});
