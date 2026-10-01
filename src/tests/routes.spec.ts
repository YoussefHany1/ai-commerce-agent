import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

const ORIGINAL_ENV = { ...process.env };

const ADMIN_KEY = '0123456789abcdef0123456789abcdef';
const SHOPIFY_SECRET = 'shopify-client-secret';
const STRIPE_WEBHOOK_SECRET = 'stripe-webhook-secret';

beforeAll(() => {
  Object.assign(process.env, {
    ADMIN_API_KEY: ADMIN_KEY,
    SHOPIFY_CLIENT_ID: 'shopify-client-id',
    SHOPIFY_CLIENT_SECRET: SHOPIFY_SECRET,
    SALLA_CLIENT_ID: 'salla-client-id',
    SALLA_CLIENT_SECRET: 'salla-client-secret',
    ZID_CLIENT_ID: 'zid-client-id',
    ZID_CLIENT_SECRET: 'zid-client-secret',
    STRIPE_WEBHOOK_SECRET,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'whatsapp-verify-token',
    RATE_LIMIT_PER_MIN: '10',
    RATE_LIMIT_CHAT_PER_MIN: '1',
    SESSION_TTL_SECONDS: '3600',
    WEBHOOK_BODY_LIMIT: '1024',
  });
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

const mocks = vi.hoisted(() => {
  const storeRepo = {
    get: vi.fn(),
    list: vi.fn(),
    byRef: vi.fn(),
    findByPlatformAndDomain: vi.fn(async () => null),
    create: vi.fn(),
    remove: vi.fn(),
    updateSettings: vi.fn(),
    updateSettingsEncrypted: vi.fn(),
    setApiKey: vi.fn(async () => {}),
    clearApiKey: vi.fn(async () => {}),
    getApiKeyHint: vi.fn(async () => null),
    getByEmbedKey: vi.fn(async () => null),
    setEmbedKey: vi.fn(async () => {}),
    getMessageTemplates: vi.fn(async (): Promise<{ id: string; name: string; text: string }[]> => []),
    setMessageTemplates: vi.fn(async () => {}),
  };
  const connectionRepo = { setTokens: vi.fn(), getTokens: vi.fn(), get: vi.fn() };
  const catalogRepo = { list: vi.fn() };
  const customerRepo = { upsert: vi.fn(), findByContact: vi.fn() };
  const conversationRepo = { ensureOpen: vi.fn(), history: vi.fn(), addMessage: vi.fn() };
  const eventRepo = { record: vi.fn() };
  const whatsappRepo = { byPhoneNumberId: vi.fn(), byStore: vi.fn(), upsert: vi.fn(), listChannels: vi.fn() };
  const billingRepo = {
    byStore: vi.fn(),
    upsertByStripeCustomer: vi.fn(),
    setPlanStatus: vi.fn(),
    updateSubscription: vi.fn(),
  };
  const jobsRepo = { enqueue: vi.fn(), list: vi.fn(), retry: vi.fn() };
  const automationRepo = { create: vi.fn(), list: vi.fn(), update: vi.fn(), remove: vi.fn() };
  const orderRepo = { byPlatformId: vi.fn(), listByCustomer: vi.fn() };
  const storeToPublic = vi.fn((s: any) => s);
  return {
    storeRepo,
    connectionRepo,
    catalogRepo,
    customerRepo,
    conversationRepo,
    eventRepo,
    whatsappRepo,
    billingRepo,
    jobsRepo,
    automationRepo,
    orderRepo,
    storeToPublic,
  };
});

const services = vi.hoisted(() => {
  const health = { dbPing: vi.fn(), redisPing: vi.fn(), rlsPing: vi.fn() };
  health.dbPing.mockResolvedValue(true);
  health.redisPing.mockResolvedValue(true);
  health.rlsPing.mockResolvedValue(true);
  return {
    health,
    retrieval: { retrieve: vi.fn(async () => []), embedMissingCatalog: vi.fn(async () => {}) },
    agent: { answerWithTools: vi.fn(async () => 'مرحباً'), toChatHistory: vi.fn((rows: any[]) => rows) },
    analytics: {
      allowsAnalytics: vi.fn(),
      getDailyMetrics: vi.fn(async () => []),
      attributionRows: vi.fn(async () => []),
      funnelByChannel: vi.fn(async () => []),
      conversionLag: vi.fn(async () => ({ overall: {}, daily: [], distribution: [] })),
      topProducts: vi.fn(async () => []),
      recordClick: vi.fn(async () => true),
      recordImpressions: vi.fn(async () => 0),
    },
    pdpl: { getCustomerData: vi.fn(), eraseCustomer: vi.fn(), purgeStorePii: vi.fn() },
    automation: { runAllAutomation: vi.fn(async () => ({ total: 0, executed: 0 })) },
    webhookApply: { applyWebhook: vi.fn(async () => {}) },
    factory: {
      getCommerceAdapter: vi.fn(async () => null),
      verifyStoreCredentials: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; code: string; message: string }),
    },
  };
});

const infra = vi.hoisted(() => {
  const store = new Map<string, { value: string; ex?: number }>();
  const sets = new Map<string, Set<string>>();
  const redis = {
    set: async (k: string, v: string, opts?: { EX?: number }) => {
      store.set(k, { value: v, ex: opts?.EX });
      return 'OK';
    },
    get: async (k: string) => store.get(k)?.value ?? null,
    del: async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
      return keys.length;
    },
    incr: async (k: string) => {
      const prev = store.get(k);
      const next = (prev ? Number(prev.value) : 0) + 1;
      store.set(k, { value: String(next) });
      return next;
    },
    expire: async (k: string, sec: number) => {
      const cur = store.get(k);
      if (cur) store.set(k, { ...cur, ex: sec });
      return 1;
    },
    ping: async () => 'PONG' as const,
    sAdd: async (k: string, member: string) => {
      if (!sets.has(k)) sets.set(k, new Set());
      sets.get(k)!.add(member);
      return 1;
    },
    sMembers: async (k: string) => [...(sets.get(k) ?? new Set<string>())],
  };
  return { store, redis };
});

const tenant = vi.hoisted(() => ({
  rows: vi.fn(async () => [] as Array<{ hash: string | null; hint: string | null }>),
}));

vi.mock('../lib/redis.js', () => ({ getRedis: async () => infra.redis }));
vi.mock('../db/repos.js', () => ({ ...mocks }));
vi.mock('../db/client.js', () => ({
  withTenant: async (_storeId: string, fn: (tx: any) => Promise<unknown>) =>
    fn({
      select: () => ({
        from: () => ({ where: async () => tenant.rows() }),
      }),
    }),
  withOperator: async (fn: (tx: any) => Promise<unknown>) => fn({}),
}));
vi.mock('../lib/health.js', () => services.health);
vi.mock('../services/retrieval.js', () => services.retrieval);
vi.mock('../services/agent.js', () => services.agent);
vi.mock('../services/analytics.js', () => services.analytics);
vi.mock('../services/pdpl.js', () => services.pdpl);
vi.mock('../services/automation.js', () => services.automation);
vi.mock('../lib/webhookApply.js', () => services.webhookApply);
vi.mock('../integrations/factory.js', () => services.factory);

function shopifyHmac(body: Buffer | string): string {
  return createHmac('sha256', SHOPIFY_SECRET).update(body).digest('hex');
}

function shopifyOAuthQuery(params: Record<string, string>): string {
  const pairs = Object.entries(params)
    .filter(([k]) => k !== 'hmac')
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`);
  const hmac = createHmac('sha256', SHOPIFY_SECRET)
    .update(pairs.join('&'))
    .digest('hex');
  return new URLSearchParams({ ...params, hmac }).toString();
}

async function buildApp() {
  vi.resetModules();
  const { default: Fastify } = await import('fastify');
  const { default: cors } = await import('@fastify/cors');
  const { default: formbody } = await import('@fastify/formbody');
  const { z } = await import('zod');
  const { api } = await import('../routes/api.js');
  const { oauth } = await import('../routes/oauth.js');
  const { webhooks, registerRawBody } = await import('../routes/webhooks.js');
  const { whatsapp } = await import('../routes/whatsapp.js');
  const { billing } = await import('../routes/billing.js');
  const { analytics } = await import('../routes/analytics.js');
  const { jobs: jobsRoutes } = await import('../routes/jobs.js');
  const { session: sessionRoutes } = await import('../routes/session.js');
  const { automation: automationRoutes } = await import('../routes/automation.js');
  const { pdpl: pdplRoutes } = await import('../routes/pdpl.js');
  const { widget } = await import('../routes/widget.js');
  const { widgetCorsHook } = await import('../lib/widget.js');

  const app = Fastify({ logger: false });
  app.setErrorHandler((error: any, _req, reply) => {
    if (error.headers) reply.headers(error.headers);
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'validation_error', issues: error.issues });
    }
    if (Number.isInteger(error.statusCode) && error.statusCode !== 500) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    reply.code(500).send({ error: 'internal_error' });
  });
  // Same ordering as src/server.ts: the widget hook must see preflights first.
  widgetCorsHook(app);
  await app.register(cors, {
    origin: 'http://localhost',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-Api-Key', 'X-Store-Id', 'Authorization', 'X-Embed-Key'],
  });
  await app.register(formbody);
  await registerRawBody(app);
  await api(app);
  await oauth(app);
  await sessionRoutes(app);
  await webhooks(app);
  await whatsapp(app);
  await billing(app);
  await analytics(app);
  await jobsRoutes(app);
  await automationRoutes(app);
  await pdplRoutes(app);
  await widget(app);
  return app;
}

type App = Awaited<ReturnType<typeof buildApp>>;

function store(id: string, planStatus = 'trial') {
  return { id, name: 'Shop', platform: 'shopify', planStatus, shopDomain: 'demo.myshopify.com' };
}

async function mintSession(app: App, storeId = 's1'): Promise<string> {
  mocks.storeRepo.get.mockImplementation(async () => store(storeId));
  mocks.customerRepo.upsert.mockResolvedValue('cust-1');
  mocks.conversationRepo.ensureOpen.mockResolvedValue('conv-1');
  const res = await app.inject({
    method: 'POST',
    url: '/api/session',
    headers: { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' },
    payload: JSON.stringify({ storeId }),
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

describe('routes: health', () => {
  let app: App;
  beforeEach(async () => {
    infra.store.clear();
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('returns 200 ok when postgres and redis both respond', async () => {
    services.health.dbPing.mockResolvedValue(true);
    services.health.redisPing.mockResolvedValue(true);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', ok: true, deps: { db: true, redis: true } });
  });

  it('fails closed with 503 when redis is unreachable', async () => {
    services.health.redisPing.mockResolvedValue(false);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'error', redis: false });
  });

  it('fails closed with 503 when postgres is unreachable', async () => {
    services.health.dbPing.mockResolvedValue(false);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'error', db: false });
  });

  it('fails closed with 503 when RLS is not actually enforced', async () => {
    // An owner or superuser connection passes the old catalog check while
    // ignoring every tenant policy, so reporting 200 here is what let a
    // cross-tenant read look healthy. Dockerfile's HEALTHCHECK keys off this
    // status, so it has to fail.
    services.health.dbPing.mockResolvedValue(true);
    services.health.redisPing.mockResolvedValue(true);
    services.health.rlsPing.mockResolvedValue(false);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    // The 503 body spreads deps flat, unlike the 200 body which nests it.
    expect(res.json()).toMatchObject({ status: 'error', db: true, redis: true, rls: false });
  });
});

describe('routes: POST /api/stores credential handling', () => {
  let app: App;
  beforeEach(async () => {
    infra.store.clear();
    vi.clearAllMocks();
    services.factory.verifyStoreCredentials.mockResolvedValue({ ok: true });
    mocks.storeRepo.findByPlatformAndDomain.mockResolvedValue(null);
    mocks.storeRepo.create.mockResolvedValue('new-store');
    app = await buildApp();
  });

  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/api/stores',
      headers: { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    });

  it('rejects a store with no access token, because it could never sync', async () => {
    const res = await post({ name: 'Shop', platform: 'shopify', shopDomain: 'demo.myshopify.com' });
    expect(res.statusCode).toBe(400);
    expect(services.factory.verifyStoreCredentials).not.toHaveBeenCalled();
    expect(mocks.storeRepo.create).not.toHaveBeenCalled();
  });

  it('rejects an empty access token', async () => {
    const res = await post({ name: 'Shop', platform: 'shopify', shopDomain: 'demo.myshopify.com', accessToken: '' });
    expect(res.statusCode).toBe(400);
    expect(mocks.storeRepo.create).not.toHaveBeenCalled();
  });

  it('refuses to persist credentials the platform rejects', async () => {
    services.factory.verifyStoreCredentials.mockResolvedValue({
      ok: false,
      code: 'unreachable',
      message: 'Shopify 401',
    });
    const res = await post({
      name: 'Shop',
      platform: 'shopify',
      shopDomain: 'demo.myshopify.com',
      accessToken: 'shpat_bad',
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body).toMatchObject({ error: 'invalid_store_credentials', reason: 'unreachable' });
    // The raw platform text is kept for logs but must not be what the user is shown.
    expect(body.detail).toBe('Shopify 401');
    expect(body.message).not.toBe('Shopify 401');
    expect(mocks.storeRepo.create).not.toHaveBeenCalled();
  });

  it('reports a missing shop domain as its own actionable reason', async () => {
    services.factory.verifyStoreCredentials.mockResolvedValue({
      ok: false,
      code: 'missing_shop_domain',
      message: 'Shopify needs a shop domain',
    });
    const res = await post({ name: 'Shop', platform: 'shopify', accessToken: 'shpat_ok' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ reason: 'missing_shop_domain' });
  });

  it('creates the store once the credentials verify', async () => {
    const res = await post({
      name: 'Shop',
      platform: 'shopify',
      shopDomain: 'demo.myshopify.com',
      accessToken: 'shpat_ok',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'new-store' });
    expect(services.factory.verifyStoreCredentials).toHaveBeenCalledWith({
      platform: 'shopify',
      shopDomain: 'demo.myshopify.com',
      accessToken: 'shpat_ok',
    });
    expect(mocks.storeRepo.create).toHaveBeenCalledOnce();
  });

  it('kicks both catalog and order sync so analytics populate without waiting for a tick', async () => {
    await post({ name: 'Shop', platform: 'shopify', shopDomain: 'demo.myshopify.com', accessToken: 'shpat_ok' });
    const types = mocks.jobsRepo.enqueue.mock.calls.map((c) => c[1]);
    expect(types).toContain('order.sync');
    expect(types).toContain('catalog.sync');
  });
});

describe('routes: admin key auth', () => {
  let app: App;
  beforeEach(async () => {
    infra.store.clear();
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('rejects a missing api key with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stores' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('rejects a wrong api key with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/stores', headers: { 'x-api-key': 'wrong-key-wrong-key-wrong-key!' } });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the correct api key', async () => {
    mocks.storeRepo.list.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/api/stores', headers: { 'x-api-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
    expect(mocks.storeRepo.list).toHaveBeenCalledOnce();
  });

  it('locks an IP out with 429 after repeated wrong keys', async () => {
    for (let i = 0; i < 30; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/stores', headers: { 'x-api-key': 'bad' } });
      expect(res.statusCode).toBe(401);
    }
    const locked = await app.inject({ method: 'GET', url: '/api/stores', headers: { 'x-api-key': 'bad' } });
    expect(locked.statusCode).toBe(429);
  });
});

describe('routes: chat + sessions', () => {
  let app: App;
  beforeEach(async () => {
    infra.store.clear();
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('requires a bearer session token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ message: 'أهلاً' }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_session' });
  });

  it('rejects an empty chat message with a validation error', async () => {
    const token = await mintSession(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ message: '' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error' });
  });

  it('rejects a chat message longer than 2000 characters', async () => {
    const token = await mintSession(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ message: 'x'.repeat(2001) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'validation_error' });
  });

  it('persists the turn and returns a reply for a valid session', async () => {
    mocks.conversationRepo.history.mockResolvedValue([]);
    mocks.conversationRepo.addMessage.mockResolvedValue(undefined);
    services.retrieval.retrieve.mockResolvedValue([]);
    services.agent.answerWithTools.mockResolvedValue('مرحباً');
    const token = await mintSession(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ message: 'أهلاً' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ reply: 'مرحباً', products: [] });
    expect(mocks.conversationRepo.addMessage).toHaveBeenCalledTimes(2);
  });

  it('rate-limits chat per store with 429', async () => {
    mocks.conversationRepo.history.mockResolvedValue([]);
    mocks.conversationRepo.addMessage.mockResolvedValue(undefined);
    services.retrieval.retrieve.mockResolvedValue([]);
    services.agent.answerWithTools.mockResolvedValue('رد');
    const token = await mintSession(app);
    const call = () =>
      app.inject({
        method: 'POST',
        url: '/api/chat',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: JSON.stringify({ message: 'مرحبا' }),
      });
    expect((await call()).statusCode).toBe(200);
    const second = await call();
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({ error: 'rate_limit_exceeded' });
    expect(second.headers['retry-after']).toBe('60');
  });
});

describe('routes: analytics plan gating', () => {
  let app: App;
  beforeEach(async () => {
    infra.store.clear();
    vi.clearAllMocks();
    app = await buildApp();
    services.analytics.allowsAnalytics.mockImplementation((planStatus: string) => planStatus === 'trial' || planStatus === 'active');
  });

  it('returns 402 for a store on the free plan', async () => {
    mocks.storeRepo.get.mockImplementation(async () => store('s-free', 'free'));
    const res = await app.inject({ method: 'GET', url: '/api/metrics/s-free', headers: { 'x-api-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toMatchObject({ error: 'payment_required', planStatus: 'free' });
  });

  it('returns metrics for a trial store', async () => {
    mocks.storeRepo.get.mockImplementation(async () => store('s-trial', 'trial'));
    services.analytics.getDailyMetrics.mockResolvedValue([]);
    const res = await app.inject({ method: 'GET', url: '/api/metrics/s-trial', headers: { 'x-api-key': ADMIN_KEY } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ storeId: 's-trial', totals: { orders: 0, revenue: 0 } });
  });
});

describe('routes: platform webhooks', () => {
  let app: App;
  beforeEach(async () => {
    infra.store.clear();
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('rejects a request with a bad signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      headers: { 'content-type': 'application/json', 'x-shopify-topic': 'products/create', 'x-shopify-shop-domain': 'demo.myshopify.com' },
      payload: JSON.stringify({ id: 'prod-1' }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_signature' });
  });

  it('rejects an unknown platform', async () => {
    const res = await app.inject({ method: 'POST', url: '/webhooks/nope', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a payload larger than the configured body limit with 413', async () => {
    const body = JSON.stringify({ id: 'oversize-' + 'x'.repeat(2048) });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': shopifyHmac(body),
        'x-shopify-topic': 'products/create',
        'x-shopify-shop-domain': 'demo.myshopify.com',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'payload_too_large' });
  });

  it('rejects a valid payload for an unknown store', async () => {
    mocks.storeRepo.byRef.mockResolvedValue(null);
    const body = JSON.stringify({ id: 'prod-9' });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': shopifyHmac(body),
        'x-shopify-topic': 'products/create',
        'x-shopify-shop-domain': 'nope.myshopify.com',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'store_not_found' });
  });

  it('records and applies a valid signed event', async () => {
    mocks.storeRepo.byRef.mockImplementation(async () => ({ id: 's-web' }));
    mocks.eventRepo.record.mockResolvedValue(true);
    const body = JSON.stringify({ id: 'prod-42', title: 'المنتج' });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': shopifyHmac(body),
        'x-shopify-topic': 'products/create',
        'x-shopify-shop-domain': 'demo.myshopify.com',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(mocks.eventRepo.record).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: 's-web', type: 'products/create', dedupKey: 'prod-42' }),
    );
    expect(services.webhookApply.applyWebhook).toHaveBeenCalledOnce();
  });

  it('routes an app/uninstalled event to the apply layer', async () => {
    mocks.storeRepo.byRef.mockImplementation(async () => ({ id: 's-web' }));
    mocks.eventRepo.record.mockResolvedValue(true);
    const body = JSON.stringify({ id: 42 });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': shopifyHmac(body),
        'x-shopify-topic': 'app/uninstalled',
        'x-shopify-shop-domain': 'demo.myshopify.com',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(services.webhookApply.applyWebhook).toHaveBeenCalledWith('shopify', expect.objectContaining({ type: 'app/uninstalled' }), 's-web');
  });

  it('returns duplicate for an already-recorded event with no side effects', async () => {
    mocks.storeRepo.byRef.mockImplementation(async () => ({ id: 's-web' }));
    mocks.eventRepo.record.mockResolvedValue(false);
    const body = JSON.stringify({ id: 'prod-7' });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/shopify',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': shopifyHmac(body),
        'x-shopify-topic': 'orders/create',
        'x-shopify-shop-domain': 'demo.myshopify.com',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, duplicate: true });
    expect(services.webhookApply.applyWebhook).not.toHaveBeenCalled();
  });
});

describe('routes: stripe billing webhook', () => {
  let app: App;
  beforeEach(async () => {
    infra.store.clear();
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('rejects a request with a bad signature', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': 't=123,v1=bad', 'content-type': 'application/json' },
      payload: JSON.stringify({ type: 'checkout.session.completed', data: { object: {} } }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'invalid_signature' });
  });

  it('activates the plan on a valid checkout.session.completed event', async () => {
    const payload = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_1', customer: 'cus_1', subscription: 'sub_1', status: 'active', metadata: { store_id: 's1', plan: 'pro' } } },
    });
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${ts}.${payload}`).digest('hex');
    mocks.billingRepo.upsertByStripeCustomer.mockResolvedValue(undefined);
    mocks.billingRepo.setPlanStatus.mockResolvedValue(undefined);
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'stripe-signature': `t=${ts},v1=${sig}`, 'content-type': 'application/json' },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(mocks.billingRepo.setPlanStatus).toHaveBeenCalledWith('s1', 'active');
  });
});

describe('routes: oauth callbacks', () => {
  let app: App;
  beforeEach(async () => {
    infra.store.clear();
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('rejects a shopify callback missing oauth params', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/oauth/shopify/callback' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a shopify callback with an unknown state', async () => {
    const qs = shopifyOAuthQuery({ code: 'auth-code', shop: 'demo.myshopify.com', state: 'unknown-state' });
    const res = await app.inject({ method: 'GET', url: `/api/oauth/shopify/callback?${qs}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_state' });
  });

  it('rejects a salla callback with an unknown state', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/oauth/salla/callback?code=abc&state=unknown' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'invalid_state' });
  });
});

describe('routes: pdpl access + erasure', () => {
  let app: App;
  beforeEach(async () => {
    infra.store.clear();
    vi.clearAllMocks();
    app = await buildApp();
  });

  it('returns 404 when the data subject is unknown', async () => {
    services.pdpl.getCustomerData.mockResolvedValue(null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pdpl/access',
      headers: { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' },
      payload: JSON.stringify({ storeId: 's1', phone: '+966500000000' }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'customer_not_found' });
  });

  it('returns the customer profile on access', async () => {
    services.pdpl.getCustomerData.mockResolvedValue({ customer: { id: 'c1' }, conversations: [] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/pdpl/access',
      headers: { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' },
      payload: JSON.stringify({ storeId: 's1', phone: '+966500000000' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ customer: { id: 'c1' }, conversations: [] });
  });

  it('erases a customer', async () => {
    services.pdpl.eraseCustomer.mockResolvedValue(true);
    const res = await app.inject({
      method: 'POST',
      url: '/api/pdpl/erase',
      headers: { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' },
      payload: JSON.stringify({ storeId: 's1', email: 'c@example.com' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ erased: true });
  });
});

describe('routes: store-scoped api keys', () => {
  let app: App;
  beforeEach(async () => {
    infra.store.clear();
    vi.clearAllMocks();
    app = await buildApp();
  });

  const key = `sk_live_${'b'.repeat(64)}`;
  const secondKey = `sk_live_${'c'.repeat(64)}`;
  const keyRow = (token: string) => ({ hash: createHash('sha256').update(token).digest('hex'), hint: token.slice(-4) });

  function seedStoreKey(token: string) {
    tenant.rows.mockResolvedValue([keyRow(token)]);
  }

  it('mints a session with a valid store api key via X-Store-Id/X-Api-Key', async () => {
    seedStoreKey(key);
    mocks.storeRepo.get.mockImplementation(async () => store('s1'));
    mocks.customerRepo.upsert.mockResolvedValue('cust-1');
    mocks.conversationRepo.ensureOpen.mockResolvedValue('conv-1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { 'x-api-key': key, 'x-store-id': 's1', 'content-type': 'application/json' },
      payload: JSON.stringify({ storeId: 's1', phone: '+966555111222' }),
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().token).toBe('string');
  });

  it('rejects a store api key that does not match the requested store', async () => {
    seedStoreKey(secondKey);
    const res = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      payload: JSON.stringify({ storeId: 's2', phone: '+966555111222' }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('rejects a malformed store api key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { 'x-api-key': 'sk_live_short', 'content-type': 'application/json' },
      payload: JSON.stringify({ storeId: 's1' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects missing credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ storeId: 's1' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('requires a store for a store scoped key', async () => {
    seedStoreKey(key);
    const res = await app.inject({
      method: 'POST',
      url: '/api/session',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      payload: JSON.stringify({ phone: '+966555111222' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'store_required' });
  });

  it('accepts the operator key via bearer token on tenant routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/jobs/00000000-0000-4000-8000-000000000001',
      headers: { authorization: `Bearer ${ADMIN_KEY}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('generates and rotates a store key as operator', async () => {
    mocks.storeRepo.get.mockImplementation(async () => store('s1'));
    const created = await app.inject({
      method: 'POST',
      url: '/api/stores/s1/keys',
      headers: { 'x-api-key': ADMIN_KEY },
    });
    expect(created.statusCode).toBe(200);
    const { key: newKey, apiKeyHint } = created.json();
    expect(newKey).toMatch(/^sk_live_[0-9a-f]{64}$/);
    expect(newKey.slice(-4)).toBe(apiKeyHint);
    expect(mocks.storeRepo.setApiKey).toHaveBeenCalledWith('s1', expect.stringMatching(/^[0-9a-f]{64}$/), apiKeyHint);

    mocks.storeRepo.getApiKeyHint.mockResolvedValue(apiKeyHint);
    const hint = await app.inject({
      method: 'GET',
      url: '/api/stores/s1/keys',
      headers: { 'x-api-key': ADMIN_KEY },
    });
    expect(hint.statusCode).toBe(200);
    expect(hint.json()).toEqual({ storeId: 's1', apiKeyHint });

    const revoked = await app.inject({
      method: 'DELETE',
      url: '/api/stores/s1/keys',
      headers: { 'x-api-key': ADMIN_KEY },
    });
    expect(revoked.statusCode).toBe(200);
    expect(mocks.storeRepo.clearApiKey).toHaveBeenCalledWith('s1');
  });

  it('does not expose store keys to a store scoped key', async () => {
    seedStoreKey(key);
    const res = await app.inject({
      method: 'POST',
      url: '/api/stores/s1/keys',
      headers: { 'x-api-key': key, 'x-store-id': 's1' },
    });
    expect(res.statusCode).toBe(401);
  });
});

const EMBED_KEY = 'aca_pub_0123456789abcdef0123456789abcdef';
const WIDGET_ORIGIN = 'https://demo.myshopify.com';

function embedStore(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    name: 'Shop',
    platform: 'shopify',
    planStatus: 'active',
    shopDomain: 'demo.myshopify.com',
    settings: null,
    ...over,
  };
}

describe('routes: storefront widget', () => {
  let app: App;

  beforeEach(async () => {
    infra.store.clear();
    vi.clearAllMocks();
    app = await buildApp();
    mocks.customerRepo.upsert.mockResolvedValue('cust-widget');
    mocks.conversationRepo.ensureOpen.mockResolvedValue('conv-widget');
    mocks.storeRepo.getByEmbedKey.mockImplementation(async () => embedStore() as any);
  });

  const session = (headers: Record<string, string>, payload: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/api/widget/session',
      headers: { 'content-type': 'application/json', ...headers },
      payload: JSON.stringify(payload),
    });

  it('mints a customer session for a valid key on the store’s own origin', async () => {
    const res = await session({ 'x-embed-key': EMBED_KEY, origin: WIDGET_ORIGIN }, { email: 'a@b.co' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.conversationId).toBe('conv-widget');
    // A customer session, never the store's API key or the admin key.
    expect(JSON.stringify(body)).not.toContain(ADMIN_KEY);
    expect(JSON.stringify(body)).not.toContain('sk_live_');
    expect(mocks.customerRepo.upsert).toHaveBeenCalledWith('s1', { name: undefined, phone: undefined, email: 'a@b.co' });
    expect(mocks.conversationRepo.ensureOpen).toHaveBeenCalledWith('s1', 'cust-widget', 'web');
  });

  it('rejects a request with no embed key', async () => {
    const res = await session({ origin: WIDGET_ORIGIN });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_embed_key');
    expect(mocks.customerRepo.upsert).not.toHaveBeenCalled();
  });

  it('rejects a malformed or unknown embed key', async () => {
    // A store API key must not be accepted here, and is asserted structurally rather
    // than by pasting something shaped like a live credential into the repo.
    const storeKey = `sk_live_${'0'.repeat(64)}`;
    for (const key of ['nope', 'aca_pub_short', storeKey, `${EMBED_KEY}x`]) {
      const res = await session({ 'x-embed-key': key, origin: WIDGET_ORIGIN });
      expect(res.statusCode, `key ${key}`).toBe(401);
    }
    mocks.storeRepo.getByEmbedKey.mockImplementation(async () => null);
    const unknown = await session({ 'x-embed-key': EMBED_KEY, origin: WIDGET_ORIGIN });
    expect(unknown.statusCode).toBe(401);
    expect(mocks.customerRepo.upsert).not.toHaveBeenCalled();
  });

  it('refuses a known key from a foreign origin, before touching the AI path', async () => {
    const res = await session({ 'x-embed-key': EMBED_KEY, origin: 'https://evil.test' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('origin_not_allowed');
    expect(mocks.customerRepo.upsert).not.toHaveBeenCalled();
  });

  it('honours a configured custom domain as well as the shop domain', async () => {
    mocks.storeRepo.getByEmbedKey.mockImplementation(async () =>
      embedStore({ settings: { widgetOrigins: ['www.example.com'] } }) as any,
    );
    const ok = await session({ 'x-embed-key': EMBED_KEY, origin: 'https://www.example.com' });
    expect(ok.statusCode).toBe(200);
    const bad = await session({ 'x-embed-key': EMBED_KEY, origin: 'https://www.other.test' });
    expect(bad.statusCode).toBe(403);
  });

  it('validates the body rather than storing junk as a contact', async () => {
    const res = await session({ 'x-embed-key': EMBED_KEY, origin: WIDGET_ORIGIN }, { email: 'not-an-email' });
    expect(res.statusCode).toBe(400);
    expect(mocks.customerRepo.upsert).not.toHaveBeenCalled();
  });

  it('grants CORS to the store’s origin for the widget’s own paths', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/widget/session',
      headers: { origin: WIDGET_ORIGIN, 'x-embed-key': EMBED_KEY, 'access-control-request-method': 'POST' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WIDGET_ORIGIN);
    expect(String(res.headers['access-control-allow-headers']).toLowerCase()).toContain('x-embed-key');
    // Preflight must actually terminate the request, not fall through to a 404.
    expect(res.body).toBe('');
  });

  it('does not grant CORS to a foreign origin even with a valid key', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/widget/session',
      headers: { origin: 'https://evil.test', 'x-embed-key': EMBED_KEY, 'access-control-request-method': 'POST' },
    });
    // The global cors plugin answers 204 for every preflight (its `origin` is a
    // fixed string), so the status code cannot distinguish the two handlers. The
    // allow-origin header can: a browser only admits the request when it matches
    // its own origin, so the key must not be able to make that happen.
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.test');
  });

  it('does not widen CORS for paths outside the widget’s surface', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/stores/s1/keys',
      headers: { origin: WIDGET_ORIGIN, 'x-embed-key': EMBED_KEY, 'access-control-request-method': 'POST' },
    });
    expect(res.headers['access-control-allow-origin']).not.toBe(WIDGET_ORIGIN);
  });

  it('rate limits the mint, since it is the endpoint that spends money', async () => {
    let last = 0;
    for (let i = 0; i < 12; i += 1) {
      last = (
        await session({ 'x-embed-key': EMBED_KEY, origin: WIDGET_ORIGIN }, { email: `a${i}@b.co` })
      ).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe('routes: embed key management', () => {
  let app: App;

  beforeEach(async () => {
    infra.store.clear();
    vi.clearAllMocks();
    app = await buildApp();
    mocks.storeRepo.get.mockImplementation(async () => store('s1'));
  });

  const read = (headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/api/stores/s1/embed-key', headers });

  const create = (headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/stores/s1/embed-key', headers });

  it('reports no key before one is minted', async () => {
    mocks.storeRepo.get.mockImplementation(async () => ({ ...store('s1'), embedKey: null }));
    const res = await read({ 'x-api-key': ADMIN_KEY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ storeId: 's1', embedKey: null });
  });

  it('mints a key an operator can read back', async () => {
    const res = await create({ 'x-api-key': ADMIN_KEY });
    expect(res.statusCode).toBe(200);
    const { embedKey } = res.json();
    expect(embedKey).toMatch(/^aca_pub_[0-9a-f]{32}$/);
    expect(mocks.storeRepo.setEmbedKey).toHaveBeenCalledWith('s1', embedKey);
  });

  it('rotates to a different key, invalidating the old one', async () => {
    const first = (await create({ 'x-api-key': ADMIN_KEY })).json().embedKey;
    const second = (await create({ 'x-api-key': ADMIN_KEY })).json().embedKey;
    expect(second).not.toBe(first);
  });

  it('keeps key management behind the admin key', async () => {
    // An operator managing keys should not be able to silently mint a widget key
    // for a store they can only read.
    const res = await create({});
    expect(res.statusCode).toBe(401);
    expect(mocks.storeRepo.setEmbedKey).not.toHaveBeenCalled();
  });
});

describe('routes: automation rules', () => {
  let app: App;

  beforeEach(async () => {
    infra.store.clear();
    vi.clearAllMocks();
    app = await buildApp();
    mocks.storeRepo.get.mockImplementation(async () => store('s1'));
    mocks.automationRepo.create.mockResolvedValue('rule-1');
  });

  const headers = { 'x-api-key': ADMIN_KEY, 'content-type': 'application/json' };

  const createRule = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/api/automation/rules', headers, payload: JSON.stringify(payload) });

  it('creates a keyword rule with its keywords', async () => {
    const res = await createRule({
      storeId: 's1',
      triggerType: 'keyword',
      triggerConfig: { keywords: ['price', 'order'] },
      action: { type: 'whatsapp_text', text: 'here you go' },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.automationRepo.create).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ triggerType: 'keyword', triggerConfig: { keywords: ['price', 'order'] } }),
    );
  });

  it('rejects a keyword rule with no keywords', async () => {
    // Otherwise the rule is silently dead and reads as a bug rather than misconfiguration.
    const res = await createRule({
      storeId: 's1',
      triggerType: 'keyword',
      action: { type: 'whatsapp_text', text: 'hi' },
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.automationRepo.create).not.toHaveBeenCalled();
  });

  it('strips formatting from a fixed-recipient number', async () => {
    const res = await createRule({
      storeId: 's1',
      triggerType: 'order_placed',
      action: { type: 'whatsapp_number', phone: '+966 50 123 4567', text: 'new order' },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.automationRepo.create).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({
        action: expect.objectContaining({ phone: '966501234567' }),
      }),
    );
  });

  it('rejects a fixed-recipient action without a usable number', async () => {
    const res = await createRule({
      storeId: 's1',
      triggerType: 'order_placed',
      action: { type: 'whatsapp_number', phone: 'nope', text: 'hi' },
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.automationRepo.create).not.toHaveBeenCalled();
  });

  it('accepts the remaining new triggers', async () => {
    for (const triggerType of ['new_conversation', 'inactive_conversation', 'clicked_no_conversion']) {
      mocks.automationRepo.create.mockClear();
      const res = await createRule({
        storeId: 's1',
        triggerType,
        action: { type: 'whatsapp_text', text: 'hi' },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('round-trips saved templates', async () => {
    mocks.storeRepo.getMessageTemplates.mockResolvedValueOnce([{ id: 't1', name: 'Price', text: 'our price' }]);
    const read = await app.inject({ method: 'GET', url: '/api/automation/templates/s1', headers });
    expect(read.json().templates).toEqual([{ id: 't1', name: 'Price', text: 'our price' }]);

    const write = await app.inject({
      method: 'PUT',
      url: '/api/automation/templates/s1',
      headers,
      payload: JSON.stringify({ templates: [{ id: 't2', name: 'Ship', text: 'we ship' }] }),
    });
    expect(write.statusCode).toBe(200);
    expect(mocks.storeRepo.setMessageTemplates).toHaveBeenCalledWith('s1', [
      { id: 't2', name: 'Ship', text: 'we ship' },
    ]);
  });

  it('rejects a template with no text', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/automation/templates/s1',
      headers,
      payload: JSON.stringify({ templates: [{ id: 't2', name: 'Ship', text: '' }] }),
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.storeRepo.setMessageTemplates).not.toHaveBeenCalled();
  });

  it('keeps rule creation behind a credential', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/automation/rules',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ storeId: 's1', triggerType: 'order_placed', action: { type: 'whatsapp_text', text: 'x' } }),
    });
    expect(res.statusCode).toBe(401);
    expect(mocks.automationRepo.create).not.toHaveBeenCalled();
  });
});