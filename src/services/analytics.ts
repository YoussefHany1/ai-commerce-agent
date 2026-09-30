import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { withTenant } from '../db/client.js';
import { attributions, conversations, customers, dailyMetrics, products } from '../db/schema.js';
import type { Order } from '../types.js';

export type DailyMetricRow = {
  day: string;
  orders: number;
  revenue: number;
  attributedRevenue: number;
  conversations: number;
  messages: number;
  recommended: number;
  clicked: number;
  converted: number;
};

export type FunnelRow = {
  channel: string;
  recommended: number;
  clicked: number;
  converted: number;
  revenue: number;
  ctr: number;
  cvr: number;
  avgConversionLagHours: number;
};

export type ProductAttributionRow = {
  channel: string;
  productId: string;
  productTitle: string;
  productPrice: number;
  status: 'recommended' | 'clicked' | 'converted';
  clickedAt: string | null;
  convertedAt: string | null;
  revenue: number;
};

export type LagSummary = {
  count: number;
  avgHours: number;
  medianHours: number;
  p90Hours: number;
};

export type LagBucket = { label: string; count: number; share: number };

const LAG_BUCKETS: Array<{ label: string; min?: number; max: number }> = [
  { label: '<1h', max: 1 },
  { label: '1–6h', min: 1, max: 6 },
  { label: '6–12h', min: 6, max: 12 },
  { label: '12–24h', min: 12, max: 24 },
  { label: '1–7d', min: 24, max: 168 },
  { label: '>7d', min: 168, max: Infinity },
];

export function summarizeLag(ages: number[]): LagSummary {
  const sorted = [...ages].sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) return { count: 0, avgHours: 0, medianHours: 0, p90Hours: 0 };
  const sum = sorted.reduce((a, b) => a + b, 0);
  const pct = (p: number) => {
    const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
    return sorted[Math.max(0, idx)];
  };
  return {
    count,
    avgHours: round1(sum / count),
    medianHours: round1(pct(0.5)),
    p90Hours: round1(pct(0.9)),
  };
}

export function lagDistribution(ages: number[]): LagBucket[] {
  const total = ages.length;
  return LAG_BUCKETS.map((b) => {
    const count = ages.filter((a) => a >= (b.min ?? 0) && a < b.max).length;
    return { label: b.label, count, share: total > 0 ? round3(count / total) : 0 };
  });
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function allowsAnalytics(planStatus: string | null): boolean {
  return planStatus === 'trial' || planStatus === 'active';
}

function window(days: number) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { from, to };
}

function mergeCounts(
  acc: Map<string, DailyMetricRow>,
  key: string,
  patch: Partial<DailyMetricRow> | null,
): void {
  if (!patch) return;
  const current = acc.get(key) ?? { day: key, orders: 0, revenue: 0, attributedRevenue: 0, conversations: 0, messages: 0, recommended: 0, clicked: 0, converted: 0 };
  current.orders += patch.orders ?? 0;
  current.revenue += patch.revenue ?? 0;
  current.attributedRevenue += patch.attributedRevenue ?? 0;
  current.conversations += patch.conversations ?? 0;
  current.messages += patch.messages ?? 0;
  current.recommended += patch.recommended ?? 0;
  current.clicked += patch.clicked ?? 0;
  current.converted += patch.converted ?? 0;
  acc.set(key, current);
}

export function funnelSummary(
  raw: Array<{ channel: string; recommended: number; clicked: number; converted: number; revenue: number; avgConversionLagHours?: number }>,
): FunnelRow[] {
  return raw.map((r) => ({
    channel: r.channel,
    recommended: r.recommended,
    clicked: r.clicked,
    converted: r.converted,
    revenue: r.revenue,
    ctr: r.recommended > 0 ? round3(r.clicked / r.recommended) : 0,
    cvr: r.clicked > 0 ? round3(r.converted / r.clicked) : 0,
    avgConversionLagHours: round1(r.avgConversionLagHours ?? 0),
  }));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export async function conversionLag(
  storeId: string,
  days: number,
): Promise<{
  storeId: string;
  range: { from: string; days: number };
  overall: LagSummary;
  daily: Array<{ day: string; conversions: number; avgHours: number }>;
  distribution: LagBucket[];
}> {
  const { from, to } = window(days);
  const rows = await withTenant(storeId, async (tx) => {
    const raw = (await tx.execute(
      sql`select (extract(epoch from (converted_at - "clickedAt")) / 3600) as lag_hours,
  (date_trunc('day', converted_at)::date)::text as day
from attributions
where store_id = ${storeId} and converted_at is not null and "clickedAt" is not null
  and converted_at >= ${from.toISOString()} and converted_at < ${to.toISOString()}
order by converted_at`,
    )) as any[];
    return raw.map((r) => ({ hours: Number(r.lag_hours), day: String(r.day) }));
  });
  const ages = rows.map((r) => r.hours);
  const byDay = new Map<string, number[]>();
  for (const r of rows) {
    const list = byDay.get(r.day) ?? [];
    list.push(r.hours);
    byDay.set(r.day, list);
  }
  const daily: Array<{ day: string; conversions: number; avgHours: number }> = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
    const key = dayKey(d);
    const list = byDay.get(key) ?? [];
    daily.push({ day: key, conversions: list.length, avgHours: round1(list.reduce((a, b) => a + b, 0) / (list.length || 1)) });
  }
  return {
    storeId,
    range: { from: dayKey(from), days },
    overall: summarizeLag(ages),
    daily,
    distribution: lagDistribution(ages),
  };
}

export async function rollupDailyMetrics(storeId: string, days: number): Promise<DailyMetricRow[]> {
  const { from, to } = window(days);
  return withTenant(storeId, async (tx) => {
    // `placed_at` exists only on `orders`, so the orders-specific day expression
    // must not leak into the other tables' queries. conversations, messages and
    // attributions have no such column, and referencing one that does not exist
    // fails the whole rollup — which takes /api/metrics down for every store,
    // not just the one being measured.
    const orderDayCol = sql<string>`coalesce(placed_at, "createdAt")`;
    const orderDay = sql<string>`(date_trunc('day', ${orderDayCol})::date)::text`;
    const createdDay = sql<string>`(date_trunc('day', "createdAt")::date)::text`;
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    // Bucket on placed_at, not createdAt. A backfilled order is written long after
    // it happened, so createdAt would pile all of a store's history onto the day
    // the backfill ran. The window filter must use the same expression, or orders
    // backfilled for older days would be counted into whichever day they landed.
    const o = await tx.execute(
      sql`select ${orderDay} as day, count(*)::int as orders, coalesce(sum(total), 0) as revenue from orders where store_id = ${storeId} and ${orderDayCol} >= ${fromIso} and ${orderDayCol} < ${toIso} group by 1`,
    );
    const c = await tx.execute(
      sql`select ${createdDay} as day, count(*)::int as conversations from conversations where store_id = ${storeId} and "createdAt" >= ${fromIso} and "createdAt" < ${toIso} group by 1`,
    );
    const m = await tx.execute(
      sql`select ${createdDay} as day, count(*)::int as messages from messages where store_id = ${storeId} and "createdAt" >= ${fromIso} and "createdAt" < ${toIso} group by 1`,
    );
    const r = await tx.execute(
      sql`select ${createdDay} as day, count(*)::int as recommended from attributions where store_id = ${storeId} and "createdAt" >= ${fromIso} and "createdAt" < ${toIso} group by 1`,
    );
    const cl = await tx.execute(
      sql`select (date_trunc('day', "clickedAt")::date)::text as day, count(*)::int as clicked from attributions where store_id = ${storeId} and "clickedAt" is not null and "clickedAt" >= ${fromIso} and "clickedAt" < ${toIso} group by 1`,
    );
    const cv = await tx.execute(
      sql`select (date_trunc('day', converted_at)::date)::text as day, count(*)::int as converted from attributions where store_id = ${storeId} and converted_at is not null and converted_at >= ${fromIso} and converted_at < ${toIso} group by 1`,
    );
    const ar = await tx.execute(
      sql`select (date_trunc('day', converted_at)::date)::text as day, coalesce(sum(revenue), 0) as attributed from attributions where store_id = ${storeId} and converted_at is not null and converted_at >= ${fromIso} and converted_at < ${toIso} group by 1`,
    );

    const acc = new Map<string, DailyMetricRow>();
    for (const row of (o as any[])) mergeCounts(acc, String(row.day), { orders: Number(row.orders), revenue: Number(row.revenue) });
    for (const row of (c as any[])) mergeCounts(acc, String(row.day), { conversations: Number(row.conversations) });
    for (const row of (m as any[])) mergeCounts(acc, String(row.day), { messages: Number(row.messages) });
    for (const row of (r as any[])) mergeCounts(acc, String(row.day), { recommended: Number(row.recommended) });
    for (const row of (cl as any[])) mergeCounts(acc, String(row.day), { clicked: Number(row.clicked) });
    for (const row of (cv as any[])) mergeCounts(acc, String(row.day), { converted: Number(row.converted) });
    for (const row of (ar as any[])) mergeCounts(acc, String(row.day), { attributedRevenue: Number(row.attributed) });

    const rows: DailyMetricRow[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
      rows.push(acc.get(dayKey(d)) ?? { day: dayKey(d), orders: 0, revenue: 0, attributedRevenue: 0, conversations: 0, messages: 0, recommended: 0, clicked: 0, converted: 0 });
    }

    const stmt = tx
      .insert(dailyMetrics)
      .values(rows.map((r) => ({ storeId, day: r.day, orders: r.orders, revenue: r.revenue, attributedRevenue: r.attributedRevenue, conversations: r.conversations, messages: r.messages, recommended: r.recommended, clicked: r.clicked, converted: r.converted })))
      .onConflictDoUpdate({
        target: [dailyMetrics.storeId, dailyMetrics.day],
        set: {
          orders: sql`EXCLUDED.orders`,
          revenue: sql`EXCLUDED.revenue`,
          attributedRevenue: sql`EXCLUDED.attributed_revenue`,
          conversations: sql`EXCLUDED.conversations`,
          messages: sql`EXCLUDED.messages`,
          recommended: sql`EXCLUDED.recommended`,
          clicked: sql`EXCLUDED.clicked`,
          converted: sql`EXCLUDED.converted`,
          updatedAt: new Date(),
        },
      });
    await tx.execute(stmt.getSQL());
    return rows;
  });
}

export async function getDailyMetrics(storeId: string, days: number): Promise<DailyMetricRow[]> {
  await rollupDailyMetrics(storeId, days);
  const { from, to } = window(days);
  return withTenant(storeId, async (tx) => {
    const rows = await tx
      .select({
        day: dailyMetrics.day,
        orders: dailyMetrics.orders,
        revenue: dailyMetrics.revenue,
        attributedRevenue: dailyMetrics.attributedRevenue,
        conversations: dailyMetrics.conversations,
        messages: dailyMetrics.messages,
        recommended: dailyMetrics.recommended,
        clicked: dailyMetrics.clicked,
        converted: dailyMetrics.converted,
      })
      .from(dailyMetrics)
      .where(and(gte(dailyMetrics.day, dayKey(from)), lt(dailyMetrics.day, dayKey(to))))
      .orderBy(dailyMetrics.day);
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const out: DailyMetricRow[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
      out.push(byDay.get(dayKey(d)) ?? { day: dayKey(d), orders: 0, revenue: 0, attributedRevenue: 0, conversations: 0, messages: 0, recommended: 0, clicked: 0, converted: 0 });
    }
    return out;
  });
}

/**
 * Records that the agent recommended a product, before any click.
 *
 * This is the first stage of the funnel and the reason `clickedAt` is nullable. A
 * row created here has no `clickedAt`; `recordClick` finds it by
 * (conversation, product) and fills the column in, so a recommendation that is
 * never clicked is still visible as a recommendation — which is the only way CTR
 * means anything.
 *
 * Idempotent per (conversation, product): re-recommending the same product in the
 * same conversation does not inflate the denominator.
 */
export async function recordImpressions(
  storeId: string,
  input: { conversationId: string; productIds: string[] },
): Promise<number> {
  const ids = [...new Set(input.productIds.filter(Boolean))];
  if (!ids.length) return 0;
  return withTenant(storeId, async (tx) => {
    const [conv] = await tx
      .select({ id: conversations.id, channel: conversations.channel })
      .from(conversations)
      .where(and(eq(conversations.storeId, storeId), eq(conversations.id, input.conversationId)))
      .limit(1);
    if (!conv) return 0;

    const existing = await tx
      .select({ productId: attributions.productId })
      .from(attributions)
      .where(
        and(
          eq(attributions.storeId, storeId),
          eq(attributions.conversationId, input.conversationId),
          inArray(attributions.productId, ids),
        ),
      );
    const seen = new Set(existing.map((r) => r.productId));
    const fresh = ids.filter((id) => !seen.has(id));
    if (!fresh.length) return 0;

    await tx.insert(attributions).values(
      fresh.map((productId) => ({
        storeId,
        conversationId: input.conversationId,
        productId,
        channel: conv.channel ?? 'web',
      })),
    );
    return fresh.length;
  });
}

export async function recordClick(storeId: string, input: { conversationId: string; productId: string }): Promise<boolean> {
  return withTenant(storeId, async (tx) => {
    const [conv] = await tx
      .select({ id: conversations.id, channel: conversations.channel })
      .from(conversations)
      .where(and(eq(conversations.storeId, storeId), eq(conversations.id, input.conversationId)))
      .limit(1);
    if (!conv) return false;
    const [existing] = await tx
      .select({ id: attributions.id })
      .from(attributions)
      .where(
        and(
          eq(attributions.storeId, storeId),
          eq(attributions.conversationId, input.conversationId),
          eq(attributions.productId, input.productId),
        ),
      )
      .limit(1);
    if (existing) {
      await tx.update(attributions).set({ clickedAt: new Date() }).where(eq(attributions.id, existing.id));
    } else {
      await tx.insert(attributions).values({
        storeId,
        conversationId: input.conversationId,
        productId: input.productId,
        channel: conv.channel ?? 'web',
        clickedAt: new Date(),
      });
    }
    return true;
  });
}

export async function markConversionsForOrder(storeId: string, order: Order): Promise<number> {
  const phone = order.customer?.phone;
  const email = order.customer?.email;
  const which: SQL[] = [];
  if (phone) which.push(eq(customers.phone, phone));
  if (email) which.push(eq(customers.email, email));
  if (!which.length) return 0;
  const custMatch = or(...which);
  return withTenant(storeId, async (tx) => {
    const custs = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.storeId, storeId), custMatch as SQL));
    if (!custs.length) return 0;
    const convs = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.storeId, storeId), inArray(conversations.customerId, custs.map((c) => c.id))));
    if (!convs.length) return 0;
    const candidates = (await tx.execute(
      sql`select id from attributions where store_id = ${storeId} and conversation_id in ${convs.map((c) => c.id)} and "clickedAt" is not null and converted_at is null order by "clickedAt" desc limit 1`,
    )) as any[];
    if (!candidates.length) return 0;
    await tx
      .update(attributions)
      .set({ convertedAt: new Date(), revenue: order.total, orderId: order.id })
      .where(eq(attributions.id, candidates[0].id));
    return 1;
  });
}

export async function attributionRows(
  storeId: string,
  status: 'recommended' | 'clicked' | 'converted' | undefined,
): Promise<ProductAttributionRow[]> {
  return withTenant(storeId, async (tx) => {
    const conds = [eq(attributions.storeId, storeId)];
    if (status === 'converted') conds.push(isNotNull(attributions.convertedAt));
    if (status === 'clicked') conds.push(and(isNotNull(attributions.clickedAt), isNull(attributions.convertedAt)) as SQL);
    // "Recommended" means surfaced to the shopper and not yet clicked. This is a real
    // state now that rows are created at recommendation time, and it needs both
    // halves: without `clickedAt is null` it would also match converted rows.
    if (status === 'recommended') {
      conds.push(and(isNull(attributions.clickedAt), isNull(attributions.convertedAt)) as SQL);
    }
    const rows = await tx
      .select({
        channel: attributions.channel,
        productId: attributions.productId,
        productTitle: products.title,
        productPrice: products.price,
        clickedAt: attributions.clickedAt,
        convertedAt: attributions.convertedAt,
        revenue: attributions.revenue,
      })
      .from(attributions)
      .innerJoin(
        products,
        and(
          or(eq(attributions.productId, products.platformProductId), sql`${attributions.productId} = ${products.id}::text`),
          eq(products.storeId, storeId),
        ),
      )
      .where(and(...(conds as SQL[])))
      .orderBy(desc(attributions.createdAt));
    return rows.map((r) => ({
      channel: r.channel,
      productId: r.productId,
      productTitle: r.productTitle,
      productPrice: Number(r.productPrice),
      status: r.convertedAt ? 'converted' : r.clickedAt ? 'clicked' : 'recommended',
      clickedAt: r.clickedAt ? r.clickedAt.toISOString() : null,
      convertedAt: r.convertedAt ? r.convertedAt.toISOString() : null,
      revenue: Number(r.revenue),
    }));
  });
}

export async function funnelByChannel(storeId: string): Promise<FunnelRow[]> {
  return withTenant(storeId, async (tx) => {
    const raw = (await tx.execute(
      sql`select channel,
  count(*)::int as recommended,
  count("clickedAt") filter (where "clickedAt" is not null)::int as clicked,
  count(converted_at) filter (where converted_at is not null)::int as converted,
  coalesce(sum(revenue) filter (where converted_at is not null), 0) as revenue,
  coalesce(avg(extract(epoch from (converted_at - "clickedAt")) / 3600) filter (where converted_at is not null and "clickedAt" is not null), 0) as lag_hours
from attributions where store_id = ${storeId} group by channel order by count(*) desc`,
    )) as any[];
    return funnelSummary(raw.map((r) => ({
      channel: String(r.channel),
      recommended: Number(r.recommended),
      clicked: Number(r.clicked),
      converted: Number(r.converted),
      revenue: Number(r.revenue),
      avgConversionLagHours: Number(r.lag_hours),
    })));
  });
}

export async function topProducts(storeId: string, limit = 10): Promise<Array<{
  productId: string;
  productTitle: string;
  productPrice: number;
  recommended: number;
  clicked: number;
  converted: number;
  revenue: number;
  cvr: number;
}>> {
  return withTenant(storeId, async (tx) => {
    const rows = (await tx.execute(
      sql`select a.product_id,
  p.title as product_title,
  p.price as product_price,
  count(*)::int as recommended,
  count(a."clickedAt") filter (where a."clickedAt" is not null)::int as clicked,
  count(a.converted_at) filter (where a.converted_at is not null)::int as converted,
  coalesce(sum(a.revenue) filter (where a.converted_at is not null), 0) as revenue
from attributions a join products p on p.store_id = ${storeId} and (p.platform_product_id = a.product_id or p.id::text = a.product_id)
where a.store_id = ${storeId}
group by a.product_id, p.title, p.price
order by count(*) desc
limit ${limit}`,
    )) as any[];
    return rows.map((r) => ({
      productId: String(r.product_id),
      productTitle: String(r.product_title),
      productPrice: Number(r.product_price),
      recommended: Number(r.recommended),
      clicked: Number(r.clicked),
      converted: Number(r.converted),
      revenue: Number(r.revenue),
      cvr: r.clicked > 0 ? round3(Number(r.converted) / Number(r.clicked)) : 0,
    }));
  });
}