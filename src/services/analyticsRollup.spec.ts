import { describe, expect, test, vi, beforeEach } from 'vitest';

/**
 * rollupDailyMetrics is one big SQL statement, so the regression worth guarding is
 * in the SQL text itself: a backfilled order must be bucketed on placed_at.
 * Bucketing on createdAt would pile a store's entire history onto the day the
 * backfill ran, which is the bug that left the dashboard reading zero.
 */
const tx = {
  execute: vi.fn(),
  insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ getSQL: () => ({}) }) }) }),
};

vi.mock('../db/client.js', () => ({
  withTenant: vi.fn(async (_storeId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx)),
}));

/** Flatten a drizzle SQL object (or string) down to its text. */
function sqlText(q: unknown): string {
  if (typeof q === 'string') return q;
  const walk = (node: unknown): string => {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(walk).join(' ');
    if (typeof node === 'object') {
      const o = node as Record<string, unknown>;
      if (typeof o.value === 'string' || typeof o.value === 'number') return String(o.value);
      if ('queryChunks' in o) return walk(o.queryChunks);
      return Object.values(o).map(walk).join(' ');
    }
    return String(node);
  };
  return walk(q);
}

/** dayKey, matching analytics' own local-time formatting. */
function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The oldest day in a `days`-wide window ending today, which is rows[0]. */
function firstDayKey(days: number): string {
  const t = new Date();
  return dayKey(new Date(t.getFullYear(), t.getMonth(), t.getDate() - (days - 1)));
}

async function rollup(days = 30) {
  const { rollupDailyMetrics } = await import('../services/analytics.js');
  return rollupDailyMetrics('store-1', days);
}

const isOrdersQuery = (q: unknown) => sqlText(q).includes('from orders');

beforeEach(() => {
  tx.execute.mockReset();
  tx.execute.mockResolvedValue([]);
});

describe('rollupDailyMetrics order bucketing', () => {
  test('buckets orders on placed_at, not the row createdAt', async () => {
    await rollup();
    const orders = sqlText(tx.execute.mock.calls[0][0]);
    expect(orders).toContain('coalesce(placed_at');
    expect(orders).toContain('from orders');
  });

  test('filters the orders window on the same placed_at expression', async () => {
    await rollup();
    // The group-by bucket and both range predicates must all use it, or an order
    // backfilled for an older day would be counted into the day it landed.
    const orders = sqlText(tx.execute.mock.calls[0][0]);
    expect((orders.match(/coalesce\(placed_at/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  test('never references placed_at on tables that do not have the column', async () => {
    await rollup();
    // `placed_at` lives only on `orders`. Leaking the orders day expression into
    // another table's query raises "column does not exist", which aborts the
    // whole rollup and 500s /api/metrics for every store, not just this one.
    const offenders = tx.execute.mock.calls
      .map((c) => sqlText(c[0]))
      .filter((text) => text.includes('placed_at') && !text.includes('from orders'));
    expect(offenders).toEqual([]);
  });

  test('emits one row per day in the window, defaulting missing days to zero', async () => {
    tx.execute.mockImplementation(async (q: unknown) => {
      if (isOrdersQuery(q)) return [{ day: firstDayKey(7), orders: 3, revenue: 150 }];
      return [];
    });
    const rows = await rollup(7);
    expect(rows).toHaveLength(7);
    expect(rows[0]).toMatchObject({ day: firstDayKey(7), orders: 3, revenue: 150 });
    for (const r of rows.slice(1)) {
      expect(r).toMatchObject({ orders: 0, revenue: 0, conversations: 0, messages: 0 });
    }
  });

  test('coerces string aggregates from postgres to numbers', async () => {
    tx.execute.mockImplementation(async (q: unknown) => {
      if (isOrdersQuery(q)) return [{ day: firstDayKey(3), orders: '4', revenue: '250.75' }];
      return [];
    });
    const rows = await rollup(3);
    expect(rows[0].orders).toBe(4);
    expect(rows[0].revenue).toBe(250.75);
  });

  test('merges orders, conversations and attribution into the same day row', async () => {
    const day = firstDayKey(3);
    tx.execute.mockImplementation(async (q: unknown) => {
      const text = sqlText(q);
      if (text.includes('from orders')) return [{ day, orders: 1, revenue: 90 }];
      if (text.includes('from conversations')) return [{ day, conversations: 4 }];
      if (text.includes('from messages')) return [{ day, messages: 11 }];
      if (text.includes('from attributions') && text.includes('as recommended')) return [{ day, recommended: 3 }];
      if (text.includes('from attributions') && text.includes('as clicked')) return [{ day, clicked: 2 }];
      if (text.includes('from attributions') && text.includes('as converted')) return [{ day, converted: 1 }];
      if (text.includes('from attributions') && text.includes('as attributed')) return [{ day, attributed: 90 }];
      return [];
    });
    const rows = await rollup(3);
    expect(rows[0]).toMatchObject({
      orders: 1,
      revenue: 90,
      conversations: 4,
      messages: 11,
      recommended: 3,
      clicked: 2,
      converted: 1,
      attributedRevenue: 90,
    });
  });
});
