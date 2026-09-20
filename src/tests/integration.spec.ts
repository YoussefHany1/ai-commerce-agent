import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

const TEST_DB_URL = process.env.TEST_APP_DB_URL;
const TEST_ADMIN_URL = process.env.TEST_PGADMIN_URL;
const TEST_REDIS_URL = process.env.TEST_REDIS_URL;

const enabled = Boolean(TEST_DB_URL && TEST_ADMIN_URL && TEST_REDIS_URL);

let storeRepo: typeof import('../db/repos.js').storeRepo;
let catalogRepo: typeof import('../db/repos.js').catalogRepo;
let withTenant: typeof import('../db/client.js').withTenant;
let products: typeof import('../db/schema.js').products;
let createSession: typeof import('../lib/session.js').createSession;
let getSession: typeof import('../lib/session.js').getSession;
let revokeSession: typeof import('../lib/session.js').revokeSession;
let admin: ReturnType<typeof postgres> | undefined;

async function loadModules() {
  vi.resetModules();
  const saved = { ...process.env };
  Object.assign(process.env, {
    DATABASE_URL: TEST_DB_URL!,
    REDIS_URL: TEST_REDIS_URL!,
  });
  try {
    const client = await import('../db/client.js');
    const repos = await import('../db/repos.js');
    const schema = await import('../db/schema.js');
    const session = await import('../lib/session.js');
    withTenant = client.withTenant;
    storeRepo = repos.storeRepo;
    catalogRepo = repos.catalogRepo;
    products = schema.products;
    createSession = session.createSession;
    getSession = session.getSession;
    revokeSession = session.revokeSession;
  } finally {
    for (const k of Object.keys(process.env)) {
      if (k !== 'DATABASE_URL' && k !== 'REDIS_URL') continue;
      delete process.env[k];
      if (k === 'DATABASE_URL' && saved[k]) process.env.DATABASE_URL = saved[k];
      if (k === 'REDIS_URL' && saved[k]) process.env.REDIS_URL = saved[k];
    }
  }
}

const TABLE = {
  products: { name: 'products', idCol: 'store_id' },
  stores: { name: 'stores', idCol: 'id' },
  conversations: { name: 'conversations', idCol: 'store_id' },
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

  it('round-trips customer sessions through redis', async () => {
    const s = await storeRepo.create({ name: 'SESS', platform: 'shopify', shopDomain: 'sess.myshopify.com' });
    createdStores.push(s);
    const token = await createSession({ storeId: s, customerId: 'cust-1', conversationId: 'conv-1' });
    await expect(getSession(token)).resolves.toMatchObject({ storeId: s, customerId: 'cust-1' });
    await revokeSession(token);
    await expect(getSession(token)).resolves.toBeNull();
    await expect(getSession('no-such-token')).resolves.toBeNull();
  });
});