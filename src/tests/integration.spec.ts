import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

const TEST_DB_URL = process.env.TEST_APP_DB_URL;
const TEST_ADMIN_URL = process.env.TEST_PGADMIN_URL;
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;
const TEST_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const enabled = Boolean(TEST_DB_URL && TEST_ADMIN_URL && TEST_REDIS_URL);

let storeRepo: typeof import('../db/repos.js').storeRepo;
let clientRepo: typeof import('../db/repos.js').clientRepo;
let catalogRepo: typeof import('../db/repos.js').catalogRepo;
let connectionRepo: typeof import('../db/repos.js').connectionRepo;
let withTenant: typeof import('../db/client.js').withTenant;
let products: typeof import('../db/schema.js').products;
let createSession: typeof import('../lib/session.js').createSession;
let getSession: typeof import('../lib/session.js').getSession;
let revokeSession: typeof import('../lib/session.js').revokeSession;
let admin: ReturnType<typeof postgres> | undefined;

const INJECTED = ['DATABASE_URL', 'REDIS_URL', 'ENCRYPTION_KEY', 'ENCRYPTION_KEY_VERSION'] as const;

async function loadModules() {
  vi.resetModules();
  const saved = { ...process.env };
  Object.assign(process.env, {
    DATABASE_URL: TEST_DB_URL!,
    REDIS_URL: TEST_REDIS_URL!,
    ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    ENCRYPTION_KEY_VERSION: 'v1',
  });
  try {
    const client = await import('../db/client.js');
    const repos = await import('../db/repos.js');
    const schema = await import('../db/schema.js');
    const session = await import('../lib/session.js');
    withTenant = client.withTenant;
    storeRepo = repos.storeRepo;
    clientRepo = repos.clientRepo;
    catalogRepo = repos.catalogRepo;
    connectionRepo = repos.connectionRepo;
    products = schema.products;
    createSession = session.createSession;
    getSession = session.getSession;
    revokeSession = session.revokeSession;
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!INJECTED.includes(k as (typeof INJECTED)[number])) continue;
      delete process.env[k];
      const prior = saved[k];
      if (prior) process.env[k] = prior;
    }
  }
}

const TABLE = {
  products: { name: 'products', idCol: 'store_id' },
  stores: { name: 'stores', idCol: 'id' },
  conversations: { name: 'conversations', idCol: 'store_id' },
  platform_connections: { name: 'platform_connections', idCol: 'store_id' },
} as const;

async function adminCount(table: keyof typeof TABLE, storeId: string): Promise<number> {
  const [row] = await admin!.unsafe(
    `select count(*)::int as c from "${TABLE[table].name}" where "${TABLE[table].idCol}" = $1`,
    [storeId],
  );
  return Number(row.c);
}

const createdStores: string[] = [];

describe.skipIf(!enabled)('integration (real Postgres + Redis, RLS applied)', () => {
  beforeAll(async () => {
    if (!enabled) return;
    admin = postgres(TEST_ADMIN_URL!, { max: 2 });
    await loadModules();
  });

  afterAll(async () => {
    if (!admin) return;
    for (const sid of createdStores) await admin`delete from stores where id = ${sid}`;
    await admin.end({ timeout: 5 });
  });

  it('isolates tenants under RLS', async () => {
    const a = await storeRepo.create({ name: 'RLS A', platform: 'shopify', shopDomain: 'rls-a.myshopify.com' });
    const b = await storeRepo.create({ name: 'RLS B', platform: 'salla', shopDomain: 'rls-b.sa' });
    createdStores.push(a, b);

    await withTenant(a, (tx) =>
      tx.insert(products).values({
        storeId: a,
        platformProductId: 'a-1',
        title: 'Secret A Product',
        price: 9,
        currency: 'USD',
        available: true,
      }),
    );

    const seenFromA = await catalogRepo.list(a);
    const seenFromB = await catalogRepo.list(b);
    expect(seenFromA).toHaveLength(1);
    expect(seenFromB).toHaveLength(0);
    await expect(adminCount('products', a)).resolves.toBe(1);
    await expect(adminCount('products', b)).resolves.toBe(0);
  });

  it('tenant writes to another store are prevented by policies', async () => {
    const a = await storeRepo.create({ name: 'RLS W A', platform: 'shopify', shopDomain: 'rls-w-a.myshopify.com' });
    const b = await storeRepo.create({ name: 'RLS W B', platform: 'shopify', shopDomain: 'rls-w-b.myshopify.com' });
    createdStores.push(a, b);

    await expect(
      withTenant(b, (tx) =>
        tx.insert(products).values({
          storeId: a,
          platformProductId: 'cross-1',
          title: 'Cross-tenant write',
          price: 1,
          currency: 'USD',
          available: true,
        }),
      ),
    ).rejects.toThrow();
    await expect(adminCount('products', a)).resolves.toBe(0);
  });

  it('removing a store cascades its data and leaves other tenants untouched', async () => {
    const a = await storeRepo.create({ name: 'DEL A', platform: 'shopify', shopDomain: 'del-a.myshopify.com' });
    const b = await storeRepo.create({ name: 'DEL B', platform: 'salla', shopDomain: 'del-b.sa' });
    createdStores.push(a, b);

    await withTenant(a, (tx) =>
      tx.insert(products).values({ storeId: a, platformProductId: 'd-a', title: 'To Be Deleted', price: 5, currency: 'USD', available: true }),
    );
    await withTenant(b, (tx) =>
      tx.insert(products).values({ storeId: b, platformProductId: 'd-b', title: 'Survivor', price: 7, currency: 'USD', available: true }),
    );

    expect(await storeRepo.remove(b)).toBe(true);
    await expect(adminCount('products', b)).resolves.toBe(0);
    await expect(adminCount('products', a)).resolves.toBe(1);
    await expect(adminCount('stores', b)).resolves.toBe(0);
    expect(await storeRepo.get(b)).toBeNull();
    expect(await storeRepo.remove(b)).toBe(false);
  });

  it('scopes platform_connections reads to the operator, not just the tenant', async () => {
    // Regression: platform_connections originally shipped with only the
    // store_id isolation policy and no tenant_operator_* counterpart, so
    // withOperator() saw zero rows. That silently disabled the catalog-sync
    // scheduler (connectionRepo.listDue) and made storeRepo.remove skip the
    // table, orphaning access_token_enc / refresh_token_enc on uninstall.
    const a = await storeRepo.create({
      name: 'CONN A',
      platform: 'shopify',
      shopDomain: 'conn-a.myshopify.com',
      accessToken: 'shpat_secret_token_a',
    });
    createdStores.push(a);
    await expect(adminCount('platform_connections', a)).resolves.toBe(1);

    // Operator context must see the row, otherwise listDue enqueues nothing.
    const due = await connectionRepo.listDue(new Date());
    expect(due.map((d) => d.storeId)).toContain(a);
    expect(due.find((d) => d.storeId === a)?.platform).toBe('shopify');
  });

  it('removes platform_connections on uninstall so credentials are not orphaned', async () => {
    const a = await storeRepo.create({
      name: 'CONN DEL',
      platform: 'shopify',
      shopDomain: 'conn-del.myshopify.com',
      accessToken: 'shpat_secret_token_del',
      refreshToken: 'shpss_secret_refresh_del',
    });
    createdStores.push(a);
    await expect(adminCount('platform_connections', a)).resolves.toBe(1);

    expect(await storeRepo.remove(a)).toBe(true);
    await expect(adminCount('platform_connections', a)).resolves.toBe(0);
    await expect(adminCount('stores', a)).resolves.toBe(0);
  });

  it('scopes stores and the self row to a client under withClient', async () => {
    const { hashPassword } = await import('../lib/passwordHash.js');
    const hash = await hashPassword('correct horse battery staple');
    const clientA = await clientRepo.create({ name: 'RLS Client A', email: 'rls-client-a@example.com', passwordHash: hash });
    const clientB = await clientRepo.create({ name: 'RLS Client B', email: 'rls-client-b@example.com', passwordHash: hash });
    try {
      const storeA = await storeRepo.create({
        name: 'RLS CLI SA',
        platform: 'shopify',
        shopDomain: 'rls-cli-a.myshopify.com',
      });
      const storeB = await storeRepo.create({
        name: 'RLS CLI SB',
        platform: 'salla',
        shopDomain: 'rls-cli-b.sa',
      });
      createdStores.push(storeA, storeB);

      expect(await storeRepo.assignClient(storeA, clientA)).toBe(true);
      expect(await storeRepo.assignClient(storeB, clientB)).toBe(true);

      // withClient sees only the stores the caller owns…
      const forA = await storeRepo.listForClient(clientA);
      expect(forA.map((s) => s.id)).toEqual([storeA]);
      const forB = await storeRepo.listForClient(clientB);
      expect(forB.map((s) => s.id)).toEqual([storeB]);

      // …and only its own clients row, through the tenant_client_clients policy.
      await expect(clientRepo.getForAuth(clientA)).resolves.toMatchObject({ id: clientA, email: 'rls-client-a@example.com' });
      await expect(clientRepo.getForAuth(clientB)).resolves.toMatchObject({ id: clientB, email: 'rls-client-b@example.com' });

      // The other tenant's store stays invisible even when addressed directly.
      await expect(storeRepo.belongsToClient(storeB, clientA)).resolves.toBe(false);

      // setSupabaseUid links an auth identity from operator scope and withdraws the
      // legacy scrypt hash, so a linked account can only sign in through Supabase.
      const authUid = crypto.randomUUID();
      expect(await clientRepo.setSupabaseUid(clientA, authUid)).toBe(true);
      await expect(clientRepo.getBySupabaseUid(authUid)).resolves.toMatchObject({
        id: clientA,
        passwordHash: null,
      });
    } finally {
      for (const id of [clientA, clientB]) await admin!`delete from clients where id = ${id}`;
    }
  });

  it('round-trips customer sessions through redis', async () => {
    const s = await storeRepo.create({ name: 'SESS', platform: 'shopify', shopDomain: 'sess.myshopify.com' });
    createdStores.push(s);
    const token = await createSession({ storeId: s, customerId: 'cust-1', conversationId: 'conv-1' });
    await expect(getSession(token)).resolves.toMatchObject({ storeId: s, customerId: 'cust-1' });
    await revokeSession(token);
    await expect(getSession(token)).resolves.toBeNull();
    await expect(getSession('no-such-token')).resolves.toBeNull();
  });

  it('grants a worker lease to only one replica at a time', async () => {
    const { acquireLock } = await import('../lib/lock.js');
    const name = 'test:worker-lease';

    // Two independent acquisitions, as two API replicas would attempt.
    const first = await acquireLock(name, 30_000);
    expect(first).not.toBeNull();
    expect(await acquireLock(name, 30_000)).toBeNull();

    // The Lua release script must be token-scoped: a non-holder cannot free it.
    const stray = await acquireLock('test:other-lease', 30_000);
    expect(stray).not.toBeNull();
    await first!.release();
    expect(await acquireLock(name, 30_000)).not.toBeNull();
  });

  it('keeps a lease held across work longer than the ttl, then releases it', async () => {
    const { acquireLock, withLock } = await import('../lib/lock.js');
    const name = 'test:worker-lease-renew';

    const rival = await withLock(name, 400, async () => {
      await new Promise((r) => setTimeout(r, 1_200));
      return acquireLock(name, 400);
    });

    // Renewal held it against a TTL the work outlasted several times over.
    expect(rival).toBeNull();
    expect(await acquireLock(name, 400)).not.toBeNull();
  });

  it('seeds a fresh operator session epoch and survives concurrent creation', async () => {
    const { ensureOperatorSessionEpoch, bumpOperatorSessionEpoch, OPERATOR_EPOCH_KEY } = await import(
      '../lib/operatorSession.js'
    );
    const { getRedis } = await import('../lib/redis.js');
    const redis = await getRedis();
    await redis.del(OPERATOR_EPOCH_KEY);

    const first = await ensureOperatorSessionEpoch();
    expect(first).toMatch(/^[0-9a-f]{32}$/);

    // Concurrent callers must converge on one value, not each seeding their own.
    const concurrent = await Promise.all([
      ensureOperatorSessionEpoch(),
      ensureOperatorSessionEpoch(),
      ensureOperatorSessionEpoch(),
    ]);
    expect(new Set([first, ...concurrent]).size).toBe(1);

    const bumped = await bumpOperatorSessionEpoch();
    expect(bumped).not.toBe(first);
    await expect(ensureOperatorSessionEpoch()).resolves.toBe(bumped);
  });
});