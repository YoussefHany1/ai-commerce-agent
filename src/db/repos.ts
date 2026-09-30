import { and, count, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { withClient, withOperator, withTenant, type Db } from './client.js';
import { encryptPii, decryptPii } from '../services/pii.js';
import {
  clients,
  operators,
  stores,
  platformConnections,
  products,
  customers,
  orders,
  conversations,
  messages,
  events,
  jobs,
  whatsappChannels,
  billingSubscriptions,
  automationRules,
  automationLogs,
  attributions,
  variants,
  dailyMetrics,
  type NewStore,
  type NewPlatformConnection,
  type NewProductRow,
  type NewMessage,
  type NewEvent,
  type Store,
  type PlatformConnection,
  type WhatsappChannel,
  type NewWhatsappChannel,
  type BillingSubscription,
  type AutomationAction,
  type AutomationRule,
  type Client,
  type Operator,
} from './schema.js';
import { decryptKey, encryptKey, keyVersionOf, isEncrypted } from '../lib/encryption.js';
import { refreshProviderToken } from '../integrations/refresh.js';
import type { Platform, Product, Order } from '../types.js';

export const SENSITIVE_SETTINGS_KEYS = new Set(['zidAuthorization']);

export function storeToPublic(s: Store) {
  return {
    id: s.id,
    name: s.name,
    platform: s.platform,
    shopDomain: s.shopDomain,
    planStatus: s.planStatus,
    createdAt: s.createdAt,
  };
}

/** One shard of a client's row, safe to hand to an HTTP response. */
export function clientToPublic(c: Client) {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    status: c.status,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

type ClientCreateInput = {
  name: string;
  email: string;
  /** Legacy scrypt digest; null once Supabase Auth owns the password. */
  passwordHash: string | null;
  supabaseUid?: string;
};

export const clientRepo = {
  async create(input: ClientCreateInput): Promise<string> {
    const id = await withOperator(async (tx) => {
      const [r] = await tx.insert(clients).values(input).returning({ id: clients.id });
      return r?.id ?? '';
    });
    return id;
  },

  /** Operator view — any account. */
  async get(id: string): Promise<Client | null> {
    const [row] = await withOperator((tx) => tx.select().from(clients).where(eq(clients.id, id)));
    return row ?? null;
  },

  /** The row when acting *as* the client: scoped by the tenant_client_clients policy. */
  async getForAuth(clientId: string): Promise<{ id: string; name: string; email: string; status: string } | null> {
    const row = await withClient(clientId, (tx) =>
      tx
        .select({ id: clients.id, name: clients.name, email: clients.email, status: clients.status })
        .from(clients)
        .where(eq(clients.id, clientId)),
    );
    return row[0] ?? null;
  },

  async findByEmail(email: string): Promise<Client | null> {
    const [row] = await withOperator((tx) => tx.select().from(clients).where(eq(clients.email, email)));
    return row ?? null;
  },

  /** The account bound to a Supabase auth user, resolved in operator scope. */
  async getBySupabaseUid(uid: string): Promise<Client | null> {
    const [row] = await withOperator((tx) =>
      tx.select().from(clients).where(eq(clients.supabaseUid, uid)),
    );
    return row ?? null;
  },

  /**
   * Links a Supabase auth user to an account and withdraws the legacy scrypt hash
   * at the same time: once an identity is linked, Supabase owns the credential, and
   * keeping `passwordHash` would route `login` at the stale scrypt digest forever
   * (a client who set a new Supabase password through password recovery would then
   * fail every sign-in with the old hash). Returns false when it misses.
   */
  async setSupabaseUid(clientId: string, uid: string): Promise<boolean> {
    const done = await withOperator(async (tx) => {
      const [r] = await tx
        .update(clients)
        .set({ supabaseUid: uid, passwordHash: null, updatedAt: new Date() })
        .where(eq(clients.id, clientId))
        .returning({ id: clients.id });
      return !!r;
    });
    return done;
  },

  async list(): Promise<Client[]> {
    return withOperator((tx) =>
      tx.select().from(clients).orderBy(desc(clients.createdAt)),
    );
  },

  /** Store count per account, resolved in the same operator transaction as the list. */
  async storeCountsFor(clientIds: string[]): Promise<Map<string, number>> {
    if (clientIds.length === 0) return new Map();
    const rows = await withOperator((tx) =>
      tx
        .select({ clientId: stores.clientId, n: count() })
        .from(stores)
        .where(inArray(stores.clientId, clientIds))
        .groupBy(stores.clientId),
    );
    return new Map(rows.map((r) => [r.clientId ?? '', r.n]));
  },

  async setStatus(clientId: string, status: 'active' | 'suspended'): Promise<boolean> {
    const done = await withOperator(async (tx) => {
      const [r] = await tx
        .update(clients)
        .set({ status, updatedAt: new Date() })
        .where(eq(clients.id, clientId))
        .returning({ id: clients.id });
      return !!r;
    });
    return done;
  },

  async setPassword(clientId: string, passwordHash: string): Promise<boolean> {
    const done = await withOperator(async (tx) => {
      const [r] = await tx
        .update(clients)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(clients.id, clientId))
        .returning({ id: clients.id });
      return !!r;
    });
    return done;
  },
};

/** One row of the operator directory, safe to hand to an HTTP response. */
export function operatorToPublic(o: Operator) {
  return {
    id: o.id,
    name: o.name,
    email: o.email,
    status: o.status,
    /** Whether a Supabase Auth identity is linked, and so whether sign-in can work. */
    linked: o.supabaseUid !== null,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

type OperatorCreateInput = {
  name: string;
  email: string;
  supabaseUid?: string | null;
};

export const operatorRepo = {
  async create(input: OperatorCreateInput): Promise<string> {
    return withOperator(async (tx) => {
      const [r] = await tx.insert(operators).values(input).returning({ id: operators.id });
      return r?.id ?? '';
    });
  },

  /** Operator view — any row, active or suspended. */
  async get(id: string): Promise<Operator | null> {
    const [row] = await withOperator((tx) => tx.select().from(operators).where(eq(operators.id, id)));
    return row ?? null;
  },

  async findByEmail(email: string): Promise<Operator | null> {
    const [row] = await withOperator((tx) =>
      tx.select().from(operators).where(eq(operators.email, email)),
    );
    return row ?? null;
  },

  /** The operator bound to a Supabase auth user, resolved in operator scope. */
  async getBySupabaseUid(uid: string): Promise<Operator | null> {
    const [row] = await withOperator((tx) =>
      tx.select().from(operators).where(eq(operators.supabaseUid, uid)),
    );
    return row ?? null;
  },

  /**
   * Links a Supabase auth user to an existing operator row. Returns false when it
   * misses, so the caller can treat "no operator for this identity" as a refusal
   * rather than silently creating one — auto-provisioning on sign-in would turn
   * "anyone who can sign up at this Supabase project" into an administrator.
   */
  async setSupabaseUid(operatorId: string, uid: string): Promise<boolean> {
    const done = await withOperator(async (tx) => {
      const [r] = await tx
        .update(operators)
        .set({ supabaseUid: uid, updatedAt: new Date() })
        .where(eq(operators.id, operatorId))
        .returning({ id: operators.id });
      return !!r;
    });
    return done;
  },

  async list(): Promise<Operator[]> {
    return withOperator((tx) => tx.select().from(operators).orderBy(desc(operators.createdAt)));
  },

  async setStatus(operatorId: string, status: 'active' | 'suspended'): Promise<boolean> {
    const done = await withOperator(async (tx) => {
      const [r] = await tx
        .update(operators)
        .set({ status, updatedAt: new Date() })
        .where(eq(operators.id, operatorId))
        .returning({ id: operators.id });
      return !!r;
    });
    return done;
  },
};

export const storeRepo = {
  async create(
    input: NewStore & { accessToken?: string; refreshToken?: string; expiresAt?: Date; scopes?: string[] },
  ): Promise<string> {
    // Operator callers insert with the operator claim; a client-created store
    // inserts with the client_id claim so the tenant_client_stores WITH CHECK
    // clause proves the row is being scoped to the caller rather than trusting
    // the handler.
    const insert = async (tx: Db) => {
      const [r] = await tx
        .insert(stores)
        .values({
          name: input.name,
          platform: input.platform,
          shopDomain: input.shopDomain,
          clientId: input.clientId,
        })
        .returning({ id: stores.id });
      return r;
    };
    const row = input.clientId ? await withClient(input.clientId, insert) : await withOperator(insert);

    const connection: NewPlatformConnection = {
      storeId: row.id,
      platform: input.platform,
      keyVersion: 'v1',
      expiresAt: input.expiresAt,
      scopes: input.scopes,
    };
    if (input.accessToken) {
      connection.keyVersion = keyVersionOf(encryptKey(input.accessToken));
      connection.accessTokenEnc = encryptKey(input.accessToken);
    }
    if (input.refreshToken) connection.refreshTokenEnc = encryptKey(input.refreshToken);
    await withTenant(row.id, (tx) => tx.insert(platformConnections).values(connection));
    return row.id;
  },

  async list(): Promise<Omit<Store, never>[]> {
    return withOperator((tx) => tx.select().from(stores).orderBy(desc(stores.createdAt)));
  },

  /**
   * The stores visible to an account. Scoped by RLS rather than by a WHERE
   * clause so a filtering bug cannot earn a client a cross-tenant view.
   */
  async listForClient(clientId: string): Promise<Omit<Store, never>[]> {
    return withClient(clientId, (tx) => tx.select().from(stores).orderBy(desc(stores.createdAt)));
  },

  async belongsToClient(storeId: string, clientId: string): Promise<boolean> {
    const rows = await withClient(clientId, (tx) =>
      tx
        .select({ id: stores.id })
        .from(stores)
        .where(and(eq(stores.id, storeId), eq(stores.clientId, clientId)))
        .limit(1),
    );
    return rows.length > 0;
  },

  /** Manual duplicate guard: (platform, shop_domain) has no DB unique index. */
  async findByPlatformAndDomain(platform: string, shopDomain: string): Promise<Store | null> {
    const [row] = await withOperator((tx) =>
      tx.select().from(stores).where(and(eq(stores.platform, platform), eq(stores.shopDomain, shopDomain))).limit(1),
    );
    return row ?? null;
  },

  /** Attaches or detaches a store to an account (operator only). */
  async assignClient(storeId: string, clientId: string | null): Promise<boolean> {
    const done = await withOperator(async (tx) => {
      const [r] = await tx
        .update(stores)
        .set({ clientId })
        .where(eq(stores.id, storeId))
        .returning({ id: stores.id });
      return !!r;
    });
    return done;
  },

  async get(id: string): Promise<Store | null> {
    const [row] = await withOperator((tx) => tx.select().from(stores).where(eq(stores.id, id)));
    return row ?? null;
  },

  async setApiKey(storeId: string, hash: string, hint: string): Promise<void> {
    await withOperator((tx) =>
      tx.update(stores).set({ apiKeyHash: hash, apiKeyHint: hint }).where(eq(stores.id, storeId)),
    );
  },

  async clearApiKey(storeId: string): Promise<void> {
    await withOperator((tx) =>
      tx.update(stores).set({ apiKeyHash: null, apiKeyHint: null }).where(eq(stores.id, storeId)),
    );
  },

  async getApiKeyHint(storeId: string): Promise<string | null> {
    const [row] = await withOperator((tx) =>
      tx.select({ hint: stores.apiKeyHint }).from(stores).where(eq(stores.id, storeId)),
    );
    return row?.hint ?? null;
  },

  /**
   * Resolves a widget embed key to its store.
   *
   * Operator-scoped because it crosses the tenant boundary: the caller supplies a
   * bare key with no session, so this is the one lookup allowed to leave a tenant.
   * The key is public by construction, so this grants nothing an attacker who read
   * the storefront's source did not already have — which is exactly why the callers
   * pair it with an origin check and a rate limit.
   */
  async getByEmbedKey(embedKey: string): Promise<Store | null> {
    const [row] = await withOperator((tx) =>
      tx.select().from(stores).where(eq(stores.embedKey, embedKey)).limit(1),
    );
    return row ?? null;
  },

  async setEmbedKey(storeId: string, embedKey: string): Promise<void> {
    await withOperator((tx) =>
      tx.update(stores).set({ embedKey }).where(eq(stores.id, storeId)),
    );
  },

  async updateSettings(storeId: string, patch: Record<string, unknown>): Promise<void> {
    await withOperator(async (tx) => {
      const [row] = await tx.select({ settings: stores.settings }).from(stores).where(eq(stores.id, storeId)).limit(1);
      if (!row) return;
      await tx
        .update(stores)
        .set({ settings: { ...(row.settings ?? {}), ...patch } })
        .where(eq(stores.id, storeId));
    });
  },

  async updateSettingsEncrypted(storeId: string, key: string, secret: string): Promise<void> {
    await withOperator(async (tx) => {
      const [row] = await tx.select({ settings: stores.settings }).from(stores).where(eq(stores.id, storeId)).limit(1);
      if (!row) return;
      const enc = isEncrypted(secret) ? secret : encryptKey(secret);
      await tx
        .update(stores)
        .set({ settings: { ...(row.settings ?? {}), [key]: enc } })
        .where(eq(stores.id, storeId));
    });
  },

  async getSecret(storeId: string, key: string): Promise<string | null> {
    const settings = await this.getSettings(storeId);
    const value = settings?.[key];
    if (typeof value !== 'string' || !value) return null;
    return isEncrypted(value) ? decryptKey(value) : value;
  },

  async remove(storeId: string): Promise<boolean> {
    const done = await withOperator(async (tx) => {
      const tables = [
        messages, attributions, automationLogs, conversations, orders,
        automationRules, customers, products, variants, events, jobs,
        dailyMetrics, platformConnections, whatsappChannels, billingSubscriptions,
      ] as const;
      for (const t of tables) {
        const withStoreId = (t as any).storeId;
        if (withStoreId) await tx.delete(t as any).where(eq(withStoreId, storeId));
      }
      const [row] = await tx.delete(stores).where(eq(stores.id, storeId)).returning({ id: stores.id });
      return !!row;
    });
    return done;
  },

  async byRef(ref: string, platform: Platform): Promise<Store | null> {
    return withOperator(async (tx) => {
      const conds = [eq(stores.shopDomain, ref)];
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
        conds.push(eq(stores.id, ref));
      }
      const [row] = await tx
        .select()
        .from(stores)
        .where(and(eq(stores.platform, platform), or(...conds)))
        .limit(1);
      return row ?? null;
    });
  },

  async getConnection(storeId: string): Promise<{ token?: string; expiresAt?: Date } | null> {
    return withTenant(storeId, async (tx) => {
      const [row] = await tx.select().from(platformConnections).where(eq(platformConnections.storeId, storeId));
      if (!row) return null;
      return {
        token: row.accessTokenEnc ? decryptKey(row.accessTokenEnc) : undefined,
        expiresAt: row.expiresAt ?? undefined,
      };
    });
  },

  async getSettings(storeId: string): Promise<Record<string, unknown> | null> {
    return withOperator(async (tx) => {
      const [row] = await tx.select({ settings: stores.settings }).from(stores).where(eq(stores.id, storeId)).limit(1);
      return row?.settings ?? null;
    });
  },
};

export const catalogRepo = {
  async list(storeId: string): Promise<Product[]> {
    return withTenant(storeId, async (tx) => {
      const rows = await tx.select().from(products).where(eq(products.storeId, storeId)).orderBy(products.title);
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description ?? undefined,
        price: r.price,
        currency: r.currency,
        available: r.available,
        url: r.url ?? undefined,
        sku: r.sku ?? undefined,
      }));
    });
  },

  async syncVersion(storeId: string): Promise<number> {
    return withTenant(storeId, async (tx) => {
      const [row] = await tx
        .select({ last: sql<number>`coalesce(max(sync_version), 0)::int` })
        .from(products)
        .where(eq(products.storeId, storeId));
      return row?.last ?? 0;
    });
  },

  async upsert(storeId: string, items: Product[], syncVersion: number): Promise<void> {
    await withTenant(storeId, async (tx) => {
      for (const p of items) {
        const row: NewProductRow = {
          storeId,
          platformProductId: p.id,
          title: p.title,
          description: p.description,
          price: p.price,
          currency: p.currency,
          available: p.available,
          url: p.url,
          sku: p.sku,
          syncVersion,
        };
        await tx
          .insert(products)
          .values(row)
          .onConflictDoUpdate({
            target: [products.storeId, products.platformProductId],
            set: {
              title: p.title,
              description: p.description,
              price: p.price,
              currency: p.currency,
              available: p.available,
              url: p.url,
              sku: p.sku,
              syncVersion,
              updatedAt: sql`now()`,
            },
          });
      }
      await tx.delete(products).where(sql`store_id = ${storeId} and sync_version <> ${syncVersion}`);
    });
  },

  async upsertWebhook(storeId: string, p: Product): Promise<void> {
    await withTenant(storeId, async (tx) => {
      const row: NewProductRow = {
        storeId,
        platformProductId: p.id,
        title: p.title,
        description: p.description,
        price: p.price,
        currency: p.currency,
        available: p.available,
        url: p.url,
        sku: p.sku,
        syncVersion: 0,
      };
      await tx
        .insert(products)
        .values(row)
        .onConflictDoUpdate({
          target: [products.storeId, products.platformProductId],
          set: {
            title: p.title,
            description: p.description,
            price: p.price,
            currency: p.currency,
            available: p.available,
            url: p.url,
            sku: p.sku,
            updatedAt: sql`now()`,
          },
        });
    });
  },

  async markSynced(storeId: string): Promise<void> {
    await withTenant(storeId, (tx) =>
      tx.update(platformConnections).set({ lastSyncedAt: new Date() }).where(eq(platformConnections.storeId, storeId)),
    );
  },

  async missingEmbeddingTitles(storeId: string): Promise<{ id: string; title: string }[]> {
    return withTenant(storeId, (tx) =>
      tx
        .select({ id: products.id, title: products.title })
        .from(products)
        .where(and(eq(products.storeId, storeId), isNull(products.embedding)))
        .limit(500),
    );
  },

  async updateEmbeddings(storeId: string, rows: { id: string; embedding: number[] }[]): Promise<void> {
    await withTenant(storeId, async (tx) => {
      for (const r of rows) {
        await tx
          .update(products)
          .set({ embedding: sql`${`[${r.embedding.join(',')}]`}::vector` })
          .where(eq(products.id, r.id));
      }
    });
  },
};

export const conversationRepo = {
  async ensureOpen(storeId: string, customerId?: string, channel = 'web'): Promise<string> {
    return withTenant(storeId, async (tx) => {
      const conditions = [eq(conversations.storeId, storeId), eq(conversations.status, 'open')];
      if (customerId) conditions.push(eq(conversations.customerId, customerId));
      if (channel) conditions.push(eq(conversations.channel, channel));
      const [existing] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(...conditions))
        .limit(1);
      if (existing) return existing.id;
      const [row] = await tx
        .insert(conversations)
        .values({ storeId, customerId, channel, status: 'open' })
        .returning({ id: conversations.id });
      return row.id;
    });
  },

  async history(storeId: string, conversationId: string, limit = 20): Promise<NewMessage[]> {
    return withTenant(storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.storeId, storeId), eq(messages.conversationId, conversationId)))
        .orderBy(desc(messages.createdAt))
        .limit(limit);
      return [...rows]
        .reverse()
        .map((r) => ({ ...r, content: decryptPii(r.content) }));
    });
  },

  async addMessage(msg: NewMessage): Promise<void> {
    const values = msg.content ? { ...msg, content: encryptPii(msg.content) } : msg;
    await withTenant(msg.storeId, (tx) => tx.insert(messages).values(values));
  },
};

export const customerRepo = {
  async upsert(storeId: string, c: { platformCustomerId?: string; name?: string; phone?: string; email?: string }): Promise<string | null> {
    return withTenant(storeId, async (tx) => {
      if (!c.phone && !c.email && !c.platformCustomerId) return null;
      let cond: SQL;
      if (c.platformCustomerId) cond = eq(customers.platformCustomerId, c.platformCustomerId);
      else if (c.phone) cond = eq(customers.phone, c.phone);
      else cond = eq(customers.email, c.email!);
      const [existing] = await tx.select({ id: customers.id }).from(customers).where(and(eq(customers.storeId, storeId), cond)).limit(1);
      if (existing) return existing.id;
      const [row] = await tx
        .insert(customers)
        .values({ storeId, platformCustomerId: c.platformCustomerId, name: c.name, phone: c.phone, email: c.email })
        .returning({ id: customers.id });
      return row.id;
    });
  },

  async findByContact(storeId: string, identifier: string): Promise<Array<{ id: string; platformCustomerId: string | null; name: string | null; phone: string | null; email: string | null }>> {
    return withTenant(storeId, (tx) =>
      tx
        .select({
          id: customers.id,
          platformCustomerId: customers.platformCustomerId,
          name: customers.name,
          phone: customers.phone,
          email: customers.email,
        })
        .from(customers)
        .where(
          and(
            eq(customers.storeId, storeId),
            or(eq(customers.phone, identifier), eq(customers.email, identifier)),
          ),
        )
        .limit(10),
    );
  },
};

function mapOrderRow(r: {
  platformOrderId: string;
  status: string | null;
  paymentStatus: string | null;
  total: number;
  currency: string;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  placedAt: Date | null;
}): Order {
  return {
    id: r.platformOrderId,
    status: r.status ?? 'unknown',
    paymentStatus: r.paymentStatus ?? undefined,
    total: r.total ?? 0,
    currency: r.currency ?? 'SAR',
    customer: {
      name: r.customerName ?? undefined,
      phone: r.customerPhone ?? undefined,
      email: r.customerEmail ?? undefined,
    },
    placedAt: r.placedAt ?? undefined,
  };
}

export const orderRepo = {
  async byPlatformId(storeId: string, platformOrderId: string): Promise<Order | null> {
    return withTenant(storeId, async (tx) => {
      const [row] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.storeId, storeId), eq(orders.platformOrderId, platformOrderId)))
        .limit(1);
      if (!row) return null;
      return mapOrderRow(row);
    });
  },

  async listByCustomer(storeId: string, customerId: string, limit = 5): Promise<Order[]> {
    return withTenant(storeId, async (tx) => {
      const rows = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.storeId, storeId), eq(orders.customerId, customerId)))
        .orderBy(desc(orders.createdAt))
        .limit(limit);
      return rows.map(mapOrderRow);
    });
  },

  async upsert(storeId: string, o: Order): Promise<void> {
    await withTenant(storeId, async (tx) => {
      const customerId = await customerRepo.upsert(storeId, o.customer ?? {});
      await tx
        .insert(orders)
        .values({
          storeId,
          platformOrderId: o.id,
          status: o.status,
          paymentStatus: o.paymentStatus,
          total: o.total,
          currency: o.currency,
          customerId,
          customerName: o.customer?.name,
          customerPhone: o.customer?.phone,
          customerEmail: o.customer?.email,
          placedAt: o.placedAt,
        })
        .onConflictDoUpdate({
          target: [orders.storeId, orders.platformOrderId],
          set: {
            status: o.status,
            paymentStatus: o.paymentStatus,
            total: o.total,
            currency: o.currency,
            customerName: o.customer?.name,
            customerPhone: o.customer?.phone,
            customerEmail: o.customer?.email,
            // A webhook that carried no timestamp must not blank a placed_at that an
            // earlier backfill already recorded, or the rollup would move the order
            // off its real day and back onto the ingestion date.
            ...(o.placedAt ? { placedAt: o.placedAt } : {}),
          },
        });
    });
  },
};

export const whatsappRepo = {
  async upsert(input: {
    storeId: string;
    phoneNumberId: string;
    wabaId?: string;
    accessToken?: string;
  }): Promise<void> {
    await withTenant(input.storeId, async (tx) => {
      const row: NewWhatsappChannel = {
        storeId: input.storeId,
        phoneNumberId: input.phoneNumberId,
        wabaId: input.wabaId,
        keyVersion: 'v1',
      };
      if (input.accessToken) {
        row.keyVersion = keyVersionOf(encryptKey(input.accessToken));
        row.accessTokenEnc = encryptKey(input.accessToken);
      }
      await tx
        .insert(whatsappChannels)
        .values(row)
        .onConflictDoUpdate({
          target: [whatsappChannels.phoneNumberId],
          set: {
            storeId: input.storeId,
            wabaId: input.wabaId ?? sql`${whatsappChannels.wabaId}`,
            accessTokenEnc: input.accessToken ? (row.accessTokenEnc as string) : sql`${whatsappChannels.accessTokenEnc}`,
            keyVersion: input.accessToken ? row.keyVersion : sql`${whatsappChannels.keyVersion}`,
          },
        });
    });
  },

  async byPhoneNumberId(phoneNumberId: string): Promise<WhatsappChannel | null> {
    return withOperator((tx) =>
      tx
        .select()
        .from(whatsappChannels)
        .where(eq(whatsappChannels.phoneNumberId, phoneNumberId))
        .limit(1)
        .then((r) => r[0] ?? null),
    );
  },

  async byStore(storeId: string): Promise<WhatsappChannel | null> {
    return withTenant(storeId, (tx) =>
      tx
        .select()
        .from(whatsappChannels)
        .where(eq(whatsappChannels.storeId, storeId))
        .limit(1)
        .then((r) => r[0] ?? null),
    );
  },

  async listChannels(): Promise<Array<{ id: string; storeId: string; phoneNumberId: string; wabaId: string | null; createdAt: Date }>> {
    return withOperator((tx) =>
      tx
        .select({
          id: whatsappChannels.id,
          storeId: whatsappChannels.storeId,
          phoneNumberId: whatsappChannels.phoneNumberId,
          wabaId: whatsappChannels.wabaId,
          createdAt: whatsappChannels.createdAt,
        })
        .from(whatsappChannels),
    );
  },

  decryptToken(channel: WhatsappChannel): string | null {
    if (!channel.accessTokenEnc) return null;
    return isEncrypted(channel.accessTokenEnc) ? decryptKey(channel.accessTokenEnc) : channel.accessTokenEnc;
  },
};

export const billingRepo = {
  async upsertByStripeCustomer(input: {
    stripeCustomerId: string;
    storeId: string;
    plan: string;
    status: string;
    stripeSubscriptionId?: string | null;
    currentPeriodEnd?: Date | null;
  }): Promise<void> {
    await withOperator(async (tx) => {
      await tx
        .insert(billingSubscriptions)
        .values({
          storeId: input.storeId,
          plan: input.plan,
          status: input.status,
          stripeCustomerId: input.stripeCustomerId,
          stripeSubscriptionId: input.stripeSubscriptionId ?? null,
          currentPeriodEnd: input.currentPeriodEnd ?? null,
        })
        .onConflictDoUpdate({
          target: [billingSubscriptions.stripeCustomerId],
          set: {
            plan: input.plan,
            status: input.status,
            storeId: input.storeId,
            stripeSubscriptionId: input.stripeSubscriptionId ?? sql`${billingSubscriptions.stripeSubscriptionId}`,
            currentPeriodEnd: input.currentPeriodEnd ?? sql`${billingSubscriptions.currentPeriodEnd}`,
            updatedAt: new Date(),
          },
        });
    });
  },

  async updateSubscription(input: {
    stripeSubscriptionId: string;
    status: string;
    plan: string;
    stripeCustomerId?: string | null;
    currentPeriodEnd?: Date | null;
  }): Promise<string | null> {
    return withOperator(async (tx) => {
      const conds = [eq(billingSubscriptions.stripeSubscriptionId, input.stripeSubscriptionId)];
      if (input.stripeCustomerId) conds.push(eq(billingSubscriptions.stripeCustomerId, input.stripeCustomerId));
      const [row] = await tx
        .update(billingSubscriptions)
        .set({
          plan: input.plan,
          status: input.status,
          stripeSubscriptionId: input.stripeSubscriptionId,
          stripeCustomerId: input.stripeCustomerId ?? sql`${billingSubscriptions.stripeCustomerId}`,
          currentPeriodEnd: input.currentPeriodEnd ?? sql`${billingSubscriptions.currentPeriodEnd}`,
          updatedAt: new Date(),
        })
        .where(or(...conds))
        .returning({ storeId: billingSubscriptions.storeId });
      return row?.storeId ?? null;
    });
  },

  async byStore(storeId: string): Promise<BillingSubscription | null> {
    return withTenant(storeId, (tx) =>
      tx
        .select()
        .from(billingSubscriptions)
        .where(eq(billingSubscriptions.storeId, storeId))
        .limit(1)
        .then((r) => r[0] ?? null),
    );
  },

  async setPlanStatus(storeId: string, status: string): Promise<void> {
    await withOperator((tx) => tx.update(stores).set({ planStatus: status }).where(eq(stores.id, storeId)));
  },
};

export const jobsRepo = {
  MAX_ATTEMPTS: 3,
  BASE_DELAY_MS: 2_000,

  retryDelay(failures: number): number {
    return Math.min(this.BASE_DELAY_MS * 2 ** (failures - 1), 60_000);
  },

  async enqueue(
    storeId: string,
    type: string,
    payload?: Record<string, unknown>,
    opts?: { runAt?: Date },
  ): Promise<string | null> {
    return withTenant(storeId, async (tx) => {
      const [dup] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.storeId, storeId), eq(jobs.type, type), inArray(jobs.status, ['pending', 'running'])))
        .limit(1);
      if (dup) return null;
      const [row] = await tx
        .insert(jobs)
        .values({
          storeId,
          type,
          payload: payload ?? {},
          runAt: opts?.runAt ?? new Date(),
        })
        .returning({ id: jobs.id });
      return row.id;
    });
  },

  async listDue(dueBefore: Date): Promise<Array<{ id: string; storeId: string; type: string; payload: Record<string, unknown> | null }>> {
    return withOperator((tx) =>
      tx
        .select({ id: jobs.id, storeId: jobs.storeId, type: jobs.type, payload: jobs.payload })
        .from(jobs)
        .where(and(eq(jobs.status, 'pending'), sql`${jobs.runAt} <= ${dueBefore.toISOString()}`))
        .orderBy(jobs.createdAt)
        .limit(50),
    );
  },

  async run<T>(storeId: string, job: { id: string; type: string }, fn: () => Promise<T>): Promise<'done' | 'failed' | 'skipped'> {
    return withTenant(storeId, async (tx) => {
      const [taken] = await tx
        .update(jobs)
        .set({ status: 'running' })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, 'pending')))
        .returning({ id: jobs.id });
      if (!taken) return 'skipped';
      const [row] = await tx.select({ attempts: jobs.attempts }).from(jobs).where(eq(jobs.id, job.id)).limit(1);
      try {
        await fn();
        await tx.update(jobs).set({ status: 'done', runAt: new Date() }).where(eq(jobs.id, job.id));
        return 'done';
      } catch (err: any) {
        const failures = (row?.attempts ?? 0) + 1;
        const dead = failures >= this.MAX_ATTEMPTS;
        await tx
          .update(jobs)
          .set({
            status: dead ? 'dead' : 'pending',
            attempts: failures,
            lastError: err?.message ? String(err.message).slice(0, 500) : 'unknown_error',
            runAt: new Date(Date.now() + this.retryDelay(failures)),
          })
          .where(eq(jobs.id, job.id));
        return 'failed';
      }
    });
  },

  async retry(storeId: string, jobId: string): Promise<boolean> {
    return withTenant(storeId, async (tx) => {
      const [row] = await tx
        .update(jobs)
        .set({ status: 'pending', attempts: 0, lastError: null, runAt: new Date() })
        .where(and(eq(jobs.id, jobId), eq(jobs.storeId, storeId)))
        .returning({ id: jobs.id });
      return !!row;
    });
  },

  async list(storeId: string, status?: string, limit = 50): Promise<Record<string, unknown>[]> {
    return withTenant(storeId, (tx) => {
      const conds = [eq(jobs.storeId, storeId)];
      if (status) conds.push(eq(jobs.status, status));
      return tx
        .select({
          id: jobs.id,
          type: jobs.type,
          status: jobs.status,
          attempts: jobs.attempts,
          lastError: jobs.lastError,
          runAt: jobs.runAt,
          createdAt: jobs.createdAt,
        })
        .from(jobs)
        .where(and(...conds))
        .orderBy(desc(jobs.createdAt))
        .limit(limit);
    });
  },
};

export const eventRepo = {
  async record(e: NewEvent): Promise<boolean> {
    return withTenant(e.storeId, async (tx) => {
      const [row] = await tx
        .insert(events)
        .values(e)
        .onConflictDoNothing({
          target: [events.storeId, events.type, events.dedupKey],
        })
        .returning({ id: events.id });
      return !!row;
    });
  },
};

export const automationRepo = {
  async create(storeId: string, input: { triggerType: string; action: AutomationAction; enabled?: boolean; cooldownMinutes?: number; lookbackHours?: number }): Promise<string> {
    return withTenant(storeId, async (tx) => {
      const [row] = await tx
        .insert(automationRules)
        .values({
          storeId,
          triggerType: input.triggerType,
          action: input.action,
          enabled: input.enabled ?? true,
          cooldownMinutes: input.cooldownMinutes ?? 1440,
          lookbackHours: input.lookbackHours ?? 72,
        })
        .returning({ id: automationRules.id });
      return row.id;
    });
  },

  async list(storeId: string): Promise<AutomationRule[]> {
    return withTenant(storeId, (tx) =>
      tx.select().from(automationRules).where(eq(automationRules.storeId, storeId)).orderBy(automationRules.createdAt),
    );
  },

  async update(storeId: string, ruleId: string, patch: { triggerType?: string; action?: AutomationAction; enabled?: boolean; cooldownMinutes?: number; lookbackHours?: number }): Promise<boolean> {
    return withTenant(storeId, async (tx) => {
      const [row] = await tx
        .update(automationRules)
        .set(patch)
        .where(and(eq(automationRules.id, ruleId), eq(automationRules.storeId, storeId)))
        .returning({ id: automationRules.id });
      return !!row;
    });
  },

  async remove(storeId: string, ruleId: string): Promise<boolean> {
    return withTenant(storeId, async (tx) => {
      const [row] = await tx
        .delete(automationRules)
        .where(and(eq(automationRules.id, ruleId), eq(automationRules.storeId, storeId)))
        .returning({ id: automationRules.id });
      return !!row;
    });
  },

  async listEnabled(): Promise<AutomationRule[]> {
    return withOperator((tx) =>
      tx.select().from(automationRules).where(eq(automationRules.enabled, true)).orderBy(automationRules.createdAt),
    );
  },

  async claim(storeId: string, ruleId: string, triggerType: string, conversationId: string, channel: string): Promise<string | null> {
    return withTenant(storeId, async (tx) => {
      const [row] = await tx
        .insert(automationLogs)
        .values({ storeId, ruleId, triggerType, conversationId, channel, status: 'pending' })
        .onConflictDoNothing({ target: [automationLogs.storeId, automationLogs.ruleId, automationLogs.conversationId] })
        .returning({ id: automationLogs.id });
      return row?.id ?? null;
    });
  },

  async complete(storeId: string, logId: string, status: string, body: string | null, error: string | null): Promise<void> {
    await withTenant(storeId, (tx) =>
      tx.update(automationLogs).set({ status, body, error }).where(eq(automationLogs.id, logId)),
    );
  },

  async markFired(storeId: string, ruleId: string): Promise<void> {
    await withTenant(storeId, (tx) =>
      tx.update(automationRules).set({ lastFiredAt: new Date() }).where(eq(automationRules.id, ruleId)),
    );
  },
};

export const connectionRepo = {
  async get(storeId: string): Promise<PlatformConnection | null> {
    return withTenant(storeId, (tx) =>
      tx.select().from(platformConnections).where(eq(platformConnections.storeId, storeId)).limit(1).then((r) => r[0] ?? null),
    );
  },

  decryptToken(conn: PlatformConnection): string | null {
    if (!conn.accessTokenEnc) return null;
    return isEncrypted(conn.accessTokenEnc) ? decryptKey(conn.accessTokenEnc) : conn.accessTokenEnc;
  },

  async setTokens(
    storeId: string,
    input: { accessToken: string; refreshToken?: string; expiresAt?: Date; scopes?: string[] },
  ): Promise<void> {
    await withTenant(storeId, async (tx) => {
      const [conn] = await tx.select().from(platformConnections).where(eq(platformConnections.storeId, storeId)).limit(1);
      if (!conn) throw new Error('no platform connection for reinstall');
      const accessEnc = encryptKey(input.accessToken);
      await tx
        .update(platformConnections)
        .set({
          accessTokenEnc: accessEnc,
          refreshTokenEnc: input.refreshToken ? encryptKey(input.refreshToken) : conn.refreshTokenEnc,
          expiresAt: input.expiresAt,
          scopes: input.scopes,
          keyVersion: keyVersionOf(accessEnc),
        })
        .where(eq(platformConnections.storeId, storeId));
    });
  },

  async refreshIfExpired(storeId: string): Promise<boolean> {
    let metadata: Record<string, unknown> | undefined;
    const ok = await withTenant(storeId, async (tx) => {
      const conn = await tx.select().from(platformConnections).where(eq(platformConnections.storeId, storeId)).limit(1).then((r) => r[0]);
      if (!conn) return false;
      if (!conn.expiresAt || conn.expiresAt.getTime() > Date.now() + 60_000) return true;
      if (conn.platform === 'shopify') return true;
      if (!conn.refreshTokenEnc) return false;
      const refreshToken = isEncrypted(conn.refreshTokenEnc) ? decryptKey(conn.refreshTokenEnc) : conn.refreshTokenEnc;
      const refreshed = await refreshProviderToken(conn.platform as Platform, refreshToken);
      if (!refreshed) return false;
      const accessEnc = encryptKey(refreshed.accessToken, conn.keyVersion);
      const refreshEnc = refreshed.refreshToken ? encryptKey(refreshed.refreshToken, conn.keyVersion) : conn.refreshTokenEnc;
      await tx
        .update(platformConnections)
        .set({
          accessTokenEnc: accessEnc,
          refreshTokenEnc: refreshEnc,
          expiresAt: refreshed.expiresAt,
          keyVersion: keyVersionOf(accessEnc),
        })
        .where(eq(platformConnections.storeId, storeId));
      metadata = refreshed.metadata;
      return true;
    });
    if (ok && metadata) {
      await withOperator(async (tx) => {
        const [storeRow] = await tx.select({ settings: stores.settings }).from(stores).where(eq(stores.id, storeId)).limit(1);
        if (!storeRow) return;
        const merged = { ...(storeRow.settings ?? {}), ...metadata! };
        for (const k of SENSITIVE_SETTINGS_KEYS) {
          const v = merged[k];
          if (typeof v === 'string' && !isEncrypted(v)) merged[k] = encryptKey(v);
        }
        await tx.update(stores).set({ settings: merged }).where(eq(stores.id, storeId));
      });
    }
    return ok;
  },

  async listDue(dueBefore: Date): Promise<{ storeId: string; platform: string }[]> {
    const conns = await withOperator((tx) =>
      tx
        .select({ storeId: platformConnections.storeId, platform: platformConnections.platform })
        .from(platformConnections)
        .where(or(isNull(platformConnections.lastSyncedAt), sql`${platformConnections.lastSyncedAt} < ${dueBefore.toISOString()}`)),
    );
    return conns;
  },

  /**
   * Connections due for an order.sync tick. Like the catalog path this matches
   * IS NULL, so a freshly installed store is picked up on the first tick and its
   * whole order history backfills without any operator action.
   */
  async listOrdersDue(dueBefore: Date): Promise<{ storeId: string; platform: string }[]> {
    return withOperator((tx) =>
      tx
        .select({ storeId: platformConnections.storeId, platform: platformConnections.platform })
        .from(platformConnections)
        .where(
          or(
            isNull(platformConnections.ordersSyncedAt),
            sql`${platformConnections.ordersSyncedAt} < ${dueBefore.toISOString()}`,
          ),
        ),
    );
  },

  async getOrdersCursor(storeId: string): Promise<Date | null> {
    // Scoped to the one column on purpose: connectionRepo.get() would pull the
    // encrypted access token into memory to read a nullable timestamp.
    return withTenant(storeId, (tx) =>
      tx
        .select({ ordersSyncedAt: platformConnections.ordersSyncedAt })
        .from(platformConnections)
        .where(eq(platformConnections.storeId, storeId))
        .limit(1)
        .then((r) => r[0]?.ordersSyncedAt ?? null),
    );
  },

  /**
   * Stores the high-water mark for order.sync. Callers pass a cursor, not the wall
   * clock: a truncated run passes the newest order it actually read, so the unread
   * remainder stays reachable instead of being skipped. A complete run passes the
   * wall clock, which is what lets an idle store stop being re-synced forever.
   */
  async markOrdersSynced(storeId: string, at: Date): Promise<void> {
    await withTenant(storeId, async (tx) => {
      await tx
        .update(platformConnections)
        .set({ ordersSyncedAt: at })
        .where(eq(platformConnections.storeId, storeId));
    });
  },
};