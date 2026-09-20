import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  boolean,
  jsonb,
  doublePrecision,
  integer,
  uniqueIndex,
  index,
  customType,
  vector,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const ts = () => timestamp({ withTimezone: true }).notNull().defaultNow();

const tsvectorType = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

export const stores = pgTable('stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  platform: text('platform').notNull(),
  shopDomain: text('shop_domain'),
  planStatus: text('plan_status').notNull().default('trial'),
  settings: jsonb('settings').$type<Record<string, unknown>>(),
  createdAt: ts(),
});

export const platformConnections = pgTable(
  'platform_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    platform: text('platform').notNull(),
    accessTokenEnc: text('access_token_enc'),
    refreshTokenEnc: text('refresh_token_enc'),
    keyVersion: text('key_version').notNull().default('v1'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    scopes: jsonb('scopes').$type<string[]>(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: ts(),
  },
  (t) => [{ name: 'platform_connections_store_id_idx', columns: [t.storeId] }],
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    platformProductId: text('platform_product_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    price: doublePrecision('price').notNull().default(0),
    currency: text('currency').notNull().default('SAR'),
    available: boolean('available').notNull().default(false),
    url: text('url'),
    sku: text('sku'),
    syncVersion: integer('sync_version').notNull().default(0),
    searchVector: tsvectorType('search_vector').generatedAlwaysAs(
      sql`(setweight(to_tsvector('simple', coalesce(title, '')), 'A') || setweight(to_tsvector('simple', coalesce(description, '')), 'B') || setweight(to_tsvector('simple', coalesce(sku, '')), 'C'))`,
    ),
    embedding: vector('embedding', { dimensions: 1536 }),
    updatedAt: ts(),
    createdAt: ts(),
  },
  (t) => [
    uniqueIndex('products_store_platform_uidx').on(t.storeId, t.platformProductId),
    index('products_store_id_idx').on(t.storeId),
    index('products_search_vector_gin').using('gin', t.searchVector),
    index('products_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export const variants = pgTable(
  'variants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    platformVariantId: text('platform_variant_id').notNull(),
    title: text('title'),
    price: doublePrecision('price').notNull().default(0),
    inventoryQuantity: integer('inventory_quantity').notNull().default(0),
    sku: text('sku'),
    createdAt: ts(),
  },
  (t) => [
    uniqueIndex('variants_store_platform_uidx').on(t.storeId, t.platformVariantId),
    index('variants_store_id_idx').on(t.storeId),
  ],
);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    platformCustomerId: text('platform_customer_id'),
    name: text('name'),
    phone: text('phone'),
    email: text('email'),
    createdAt: ts(),
  },
  (t) => [
    uniqueIndex('customers_store_platform_uidx').on(t.storeId, t.platformCustomerId),
    index('customers_store_id_idx').on(t.storeId),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    platformOrderId: text('platform_order_id').notNull(),
    status: text('status'),
    paymentStatus: text('payment_status'),
    total: doublePrecision('total').notNull().default(0),
    currency: text('currency').notNull().default('SAR'),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    customerName: text('customer_name'),
    customerPhone: text('customer_phone'),
    customerEmail: text('customer_email'),
    createdAt: ts(),
  },
  (t) => [
    uniqueIndex('orders_store_platform_uidx').on(t.storeId, t.platformOrderId),
    index('orders_store_id_idx').on(t.storeId),
  ],
);

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    channel: text('channel').notNull().default('web'),
    status: text('status').notNull().default('open'),
    createdAt: ts(),
    updatedAt: ts(),
  },
  (t) => [{ name: 'conversations_store_id_idx', columns: [t.storeId] }],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: ts(),
  },
  (t) => [
    index('messages_store_id_idx').on(t.storeId),
    index('messages_conversation_id_idx').on(t.conversationId),
  ],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    type: text('type').notNull(),
    dedupKey: text('dedup_key'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: ts(),
  },
  (t) => [
    uniqueIndex('events_store_dedup_uidx').on(t.storeId, t.type, t.dedupKey),
    index('events_store_id_idx').on(t.storeId),
  ],
);

export type AutomationAction = { type: 'whatsapp_text'; text: string };

export const automationRules = pgTable(
  'automation_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    triggerType: text('trigger_type').notNull(),
    action: jsonb('action').notNull().$type<AutomationAction>(),
    enabled: boolean('enabled').notNull().default(true),
    cooldownMinutes: integer('cooldown_minutes').notNull().default(1440),
    lookbackHours: integer('lookback_hours').notNull().default(72),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
    createdAt: ts(),
  },
  (t) => [{ name: 'automation_rules_store_id_idx', columns: [t.storeId] }],
);

export const automationLogs = pgTable(
  'automation_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    ruleId: uuid('rule_id').references(() => automationRules.id, { onDelete: 'cascade' }),
    triggerType: text('trigger_type').notNull(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    channel: text('channel').notNull().default('whatsapp'),
    status: text('status').notNull().default('pending'),
    body: text('body'),
    error: text('error'),
    createdAt: ts(),
  },
  (t) => [
    uniqueIndex('automation_logs_rule_conv_uidx').on(t.storeId, t.ruleId, t.conversationId),
    index('automation_logs_store_id_idx').on(t.storeId),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    runAt: timestamp('run_at', { withTimezone: true }),
    createdAt: ts(),
  },
  (t) => [
    index('jobs_store_id_idx').on(t.storeId),
    index('jobs_status_idx').on(t.status),
  ],
);

export const attributions = pgTable(
  'attributions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id').notNull(),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    productId: text('product_id').notNull(),
    orderId: text('order_id'),
    channel: text('channel').notNull().default('web'),
    createdAt: ts(),
    clickedAt: ts(),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    revenue: doublePrecision('revenue').notNull().default(0),
  },
  (t) => [
    index('attributions_store_id_idx').on(t.storeId),
    index('attributions_conv_idx').on(t.conversationId, t.productId),
  ],
);

export const whatsappChannels = pgTable(
  'whatsapp_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    phoneNumberId: text('phone_number_id').notNull(),
    wabaId: text('waba_id'),
    accessTokenEnc: text('access_token_enc'),
    keyVersion: text('key_version').notNull().default('v1'),
    createdAt: ts(),
  },
  (t) => [uniqueIndex('whatsapp_channels_phone_uidx').on(t.phoneNumberId)],
);

export const billingSubscriptions = pgTable(
  'billing_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    plan: text('plan').notNull().default('free'),
    status: text('status').notNull().default('inactive'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    updatedAt: ts(),
    createdAt: ts(),
  },
  (t) => [
    uniqueIndex('billing_store_uidx').on(t.storeId),
    uniqueIndex('billing_customer_uidx').on(t.stripeCustomerId),
    uniqueIndex('billing_subscription_uidx').on(t.stripeSubscriptionId),
  ],
);

export const dailyMetrics = pgTable(
  'daily_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    day: date('day', { mode: 'string' }).notNull(),
    orders: integer('orders').notNull().default(0),
    revenue: doublePrecision('revenue').notNull().default(0),
    attributedRevenue: doublePrecision('attributed_revenue').notNull().default(0),
    conversations: integer('conversations').notNull().default(0),
    messages: integer('messages').notNull().default(0),
    recommended: integer('recommended').notNull().default(0),
    clicked: integer('clicked').notNull().default(0),
    converted: integer('converted').notNull().default(0),
    updatedAt: ts(),
    createdAt: ts(),
  },
  (t) => [
    uniqueIndex('daily_metrics_store_day_uidx').on(t.storeId, t.day),
    index('daily_metrics_store_id_idx').on(t.storeId),
  ],
);

export type Store = typeof stores.$inferSelect;
export type NewStore = typeof stores.$inferInsert;
export type PlatformConnection = typeof platformConnections.$inferSelect;
export type NewPlatformConnection = typeof platformConnections.$inferInsert;
export type ProductRow = typeof products.$inferSelect;
export type NewProductRow = typeof products.$inferInsert;
export type OrderRow = typeof orders.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type WhatsappChannel = typeof whatsappChannels.$inferSelect;
export type NewWhatsappChannel = typeof whatsappChannels.$inferInsert;
export type BillingSubscription = typeof billingSubscriptions.$inferSelect;
export type NewBillingSubscription = typeof billingSubscriptions.$inferInsert;
export type DailyMetric = typeof dailyMetrics.$inferSelect;
  export type NewDailyMetric = typeof dailyMetrics.$inferInsert;
  export type AutomationRule = typeof automationRules.$inferSelect;
  export type NewAutomationRule = typeof automationRules.$inferInsert;
  export type AutomationLog = typeof automationLogs.$inferSelect;
  export type NewAutomationLog = typeof automationLogs.$inferInsert;