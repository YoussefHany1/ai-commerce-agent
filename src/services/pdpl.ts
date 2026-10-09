import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { withTenant, type Db } from '../db/client.js';
import { attributions, automationLogs, conversations, customers, messages, orders } from '../db/schema.js';
import { decryptPii } from './pii.js';
import { revokeSessionsForCustomers } from '../lib/session.js';
import { config } from '../config.js';

export type RetentionSettings = {
  conversationsDays: number;
  attributionsDays: number;
  eventsDays: number;
  customersDays: number;
};

export function retentionCutoffs(now: Date, settings: RetentionSettings) {
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
  return {
    conversations: daysAgo(settings.conversationsDays),
    attributions: daysAgo(settings.attributionsDays),
    events: daysAgo(settings.eventsDays),
    customers: daysAgo(settings.customersDays),
  };
}

export type CustomerRef = { storeId?: string; phone?: string | null; email?: string | null };

/**
 * Resolves customer rows for a reference.
 *
 * The manual operator endpoints match *all* provided identifiers (phone AND email),
 * because the operator controls the input and a partial match risks erasing the wrong
 * person. Webhook-fed gather/erase requests match *any* provided identifier instead
 * (phone OR email): Shopify's `customers/redact` payload carries the identifiers it
 * knows (often only email), and a partial match on the store's own copy is the best
 * available resolution — missing the request entirely is worse than over-matching one
 * row. With no identifier at all the request must not match the whole store, so it
 * resolves to nothing.
 */
async function resolveCustomerIds(
  tx: Db,
  storeId: string,
  ref: CustomerRef,
  matchAny = false,
): Promise<string[]> {
  const byPhone = ref.phone ? eq(customers.phone, ref.phone) : null;
  const byEmail = ref.email ? eq(customers.email, ref.email) : null;
  if (!byPhone && !byEmail) return [];
  const conds: SQL[] = [eq(customers.storeId, storeId)];
  if (matchAny && byPhone && byEmail) {
    conds.push(or(byPhone, byEmail)!);
  } else if (byPhone) {
    conds.push(byPhone);
  } else if (byEmail) {
    conds.push(byEmail);
  }
  const rows = await tx.select({ id: customers.id }).from(customers).where(and(...conds));
  return rows.map((r) => r.id);
}

export type PurgeCounts = {
  conversations: number;
  attributions: number;
  events: number;
  customers: number;
  total: number;
};

export async function purgeStorePii(storeId: string, now = new Date(), settings?: RetentionSettings): Promise<PurgeCounts> {
  const effective = settings ?? {
    conversationsDays: config.RETENTION_CONVERSATIONS_DAYS,
    attributionsDays: config.RETENTION_ATTRIBUTIONS_DAYS,
    eventsDays: config.RETENTION_EVENTS_DAYS,
    customersDays: config.RETENTION_CUSTOMER_ORPHAN_DAYS,
  };
  const cutoffs = retentionCutoffs(now, effective);
  return withTenant(storeId, async (tx) => {
    const conversationsResult = await tx.execute(
      sql`delete from conversations where store_id = ${storeId}
        and coalesce("updatedAt", "createdAt") < ${cutoffs.conversations.toISOString()}
      returning id`,
    );
    const attributionsResult = await tx.execute(
      sql`delete from attributions where store_id = ${storeId} and "createdAt" < ${cutoffs.attributions.toISOString()}
      returning id`,
    );
    const eventsResult = await tx.execute(
      sql`delete from events where store_id = ${storeId} and "createdAt" < ${cutoffs.events.toISOString()}
      returning id`,
    );
    const customersResult = await tx.execute(
      sql`delete from customers where store_id = ${storeId} and "createdAt" < ${cutoffs.customers.toISOString()}
        and not exists (select 1 from conversations c where c.customer_id = customers.id)
        and not exists (select 1 from orders o where o.customer_id = customers.id)
      returning id`,
    );
    const conversationsDeleted = (conversationsResult as any[]).length;
    const attributionsDeleted = (attributionsResult as any[]).length;
    const eventsDeleted = (eventsResult as any[]).length;
    const customersDeleted = (customersResult as any[]).length;
    return {
      conversations: conversationsDeleted,
      attributions: attributionsDeleted,
      events: eventsDeleted,
      customers: customersDeleted,
      total: conversationsDeleted + attributionsDeleted + eventsDeleted + customersDeleted,
    };
  });
}

export async function getCustomerData(storeId: string, ref: CustomerRef) {
  return withTenant(storeId, async (tx) => {
    const ids = await resolveCustomerIds(tx, storeId, ref);
    if (!ids.length) return null;
    const custRows = await tx
      .select({ id: customers.id, name: customers.name, phone: customers.phone, email: customers.email, createdAt: customers.createdAt })
      .from(customers)
      .where(inArray(customers.id, ids));
    if (!custRows.length) return null;
    const customer = custRows[0];

    const orderRows = await tx
      .select({
        platformOrderId: orders.platformOrderId,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        total: orders.total,
        currency: orders.currency,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(inArray(orders.customerId, ids))
      .orderBy(orders.createdAt);

    const convRows = await tx
      .select({ id: conversations.id, channel: conversations.channel, status: conversations.status, createdAt: conversations.createdAt })
      .from(conversations)
      .where(inArray(conversations.customerId, ids))
      .orderBy(conversations.createdAt);

    const convIds = convRows.map((c) => c.id);
    const messageRows = convIds.length
      ? await tx
          .select({ conversationId: messages.conversationId, role: messages.role, content: messages.content, createdAt: messages.createdAt })
          .from(messages)
          .where(inArray(messages.conversationId, convIds))
          .orderBy(messages.createdAt)
      : [];
    const attrRows = convIds.length
      ? await tx
          .select({ conversationId: attributions.conversationId, productId: attributions.productId, channel: attributions.channel, clickedAt: attributions.clickedAt, convertedAt: attributions.convertedAt })
          .from(attributions)
          .where(inArray(attributions.conversationId, convIds))
          .orderBy(attributions.createdAt)
      : [];

    return {
      customer,
      orders: orderRows,
      conversations: convRows.map((c) => ({
        id: c.id,
        channel: c.channel,
        status: c.status,
        createdAt: c.createdAt,
        messages: messageRows.filter((m) => m.conversationId === c.id).map((m) => ({ role: m.role, content: decryptPii(m.content), createdAt: m.createdAt })),
        attributions: attrRows
          .filter((a) => a.conversationId === c.id)
          .map((a) => ({ productId: a.productId, channel: a.channel, clickedAt: a.clickedAt, convertedAt: a.convertedAt })),
      })),
    };
  });
}

export async function eraseCustomer(
  storeId: string,
  ref: CustomerRef,
  matchAny = false,
): Promise<boolean> {
  const ids = await withTenant(storeId, async (tx) => {
    const resolved = await resolveCustomerIds(tx, storeId, ref, matchAny);
    if (!resolved.length) return [] as string[];
    const convs = await tx.select({ id: conversations.id }).from(conversations).where(inArray(conversations.customerId, resolved));
    const convIds = convs.map((c) => c.id);
    if (convIds.length) {
      await tx.delete(automationLogs).where(inArray(automationLogs.conversationId, convIds));
      await tx.delete(attributions).where(inArray(attributions.conversationId, convIds));
      await tx.delete(conversations).where(inArray(conversations.id, convIds));
    }
    await tx
      .update(orders)
      .set({ customerId: null, customerName: null, customerPhone: null, customerEmail: null })
      .where(inArray(orders.customerId, resolved));
    await tx.delete(customers).where(inArray(customers.id, resolved));
    return resolved;
  });
  if (!ids.length) return false;
  await revokeSessionsForCustomers(storeId, ids).catch(() => {});
  return true;
}

export type EraseStoreCounts = {
  conversations: number;
  attributions: number;
  customers: number;
  total: number;
};

/**
 * Erases every customer's personal data for a store, leaving the store itself and its
 * platform connection intact.
 *
 * This is the shop-level counterpart to `eraseCustomer`, for Shopify's `shop/redact`:
 * a redact request must clear the whole store's held data, not just what retention
 * cutoffs have already aged out (which is what `purgeStorePii` does). Conversations are
 * deleted directly and their messages go with them via the FK cascade; attributions are
 * deleted by store id too, because impression-only rows have no conversation to cascade
 * from. Order PII is nulled (not deleted — the merchant keeps their ledger), and the
 * store row, token and configuration all survive.
 */
export async function eraseStorePii(storeId: string): Promise<EraseStoreCounts> {
  return withTenant(storeId, async (tx) => {
    await tx.delete(automationLogs).where(eq(automationLogs.storeId, storeId));
    const conversationsResult = await tx
      .delete(conversations)
      .where(eq(conversations.storeId, storeId))
      .returning({ id: conversations.id });
    const attributionsResult = await tx
      .delete(attributions)
      .where(eq(attributions.storeId, storeId))
      .returning({ id: attributions.id });
    await tx
      .update(orders)
      .set({ customerId: null, customerName: null, customerPhone: null, customerEmail: null })
      .where(eq(orders.storeId, storeId));
    const customersResult = await tx
      .delete(customers)
      .where(eq(customers.storeId, storeId))
      .returning({ id: customers.id });
    return {
      conversations: conversationsResult.length,
      attributions: attributionsResult.length,
      customers: customersResult.length,
      total: conversationsResult.length + attributionsResult.length + customersResult.length,
    };
  });
}