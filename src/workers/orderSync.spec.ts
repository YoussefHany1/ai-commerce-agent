import { test, expect, describe, vi, beforeEach } from 'vitest';
import type { Order } from '../types.js';

vi.mock('../db/repos.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/repos.js')>();
  return {
    ...(actual as object),
    storeRepo: { get: vi.fn() },
    orderRepo: { upsert: vi.fn() },
    connectionRepo: { getOrdersCursor: vi.fn(), markOrdersSynced: vi.fn() },
    jobsRepo: {},
    catalogRepo: {},
  };
});
vi.mock('../integrations/factory.js', () => ({ getCommerceAdapter: vi.fn() }));
vi.mock('../services/analytics.js', () => ({
  rollupDailyMetrics: vi.fn(),
  markConversionsForOrder: vi.fn(async () => 0),
}));
vi.mock('../services/retrieval.js', () => ({ embedMissingCatalog: vi.fn() }));
vi.mock('../services/pdpl.js', () => ({ purgeStorePii: vi.fn() }));
vi.mock('../lib/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

const OVERLAP_MS = 5 * 60_000;
const PAGE_LIMIT = 5_000;

function order(id: string, placedAt: string | null): Order {
  return {
    id,
    total: 100,
    currency: 'SAR',
    status: 'paid',
    placedAt: placedAt ? new Date(placedAt) : undefined,
  };
}

async function load(opts: {
  orders?: Order[];
  cursor?: Date | null;
  store?: { id: string } | null;
  adapter?: { listOrders: ReturnType<typeof vi.fn> } | null;
}) {
  const repos = await import('../db/repos.js');
  const factory = await import('../integrations/factory.js');
  const analytics = await import('../services/analytics.js');
  vi.mocked(repos.storeRepo.get).mockResolvedValue(
    (opts.store === null ? null : (opts.store ?? { id: 's1' })) as never,
  );
  vi.mocked(repos.orderRepo.upsert).mockResolvedValue(undefined as never);
  vi.mocked(repos.connectionRepo.getOrdersCursor).mockResolvedValue(opts.cursor ?? null);
  vi.mocked(repos.connectionRepo.markOrdersSynced).mockResolvedValue(undefined);
  vi.mocked(analytics.rollupDailyMetrics).mockResolvedValue(undefined as never);
  vi.mocked(analytics.markConversionsForOrder).mockResolvedValue(0 as never);
  const listOrders = vi.fn().mockResolvedValue(opts.orders ?? []);
  vi.mocked(factory.getCommerceAdapter).mockResolvedValue(
    (opts.adapter === null ? null : { listOrders: opts.adapter?.listOrders ?? listOrders }) as never,
  );
  const mod = await import('./jobs.js');
  return { ...mod, repos, factory, analytics, listOrders };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runOrderSync', () => {
  test('rejects an unusable store before touching the platform', async () => {
    const { runOrderSync, listOrders } = await load({ store: null });
    await expect(runOrderSync('s1')).rejects.toThrow(/unusable_store/);
    expect(listOrders).not.toHaveBeenCalled();
  });

  test('rejects when the store has no usable connection', async () => {
    const { runOrderSync, repos } = await load({ adapter: null });
    await expect(runOrderSync('s1')).rejects.toThrow(/no_connection/);
    expect(repos.orderRepo.upsert).not.toHaveBeenCalled();
  });

  test('backfills the whole history when no cursor exists yet', async () => {
    const { runOrderSync, listOrders, repos } = await load({
      orders: [order('o1', '2026-01-05T10:00:00Z'), order('o2', '2026-02-05T10:00:00Z')],
      cursor: null,
    });
    const res = await runOrderSync('s1');
    expect(listOrders).toHaveBeenCalledWith({ since: undefined, limit: PAGE_LIMIT });
    expect(repos.orderRepo.upsert).toHaveBeenCalledTimes(2);
    expect(res.imported).toBe(2);
  });

  test('re-reads a small overlap before the cursor and passes the cap', async () => {
    const { runOrderSync, listOrders } = await load({
      cursor: new Date('2026-03-04T12:00:00Z'),
      orders: [order('o3', '2026-03-04T12:30:00Z')],
    });
    await runOrderSync('s1');
    const arg = listOrders.mock.calls[0][0] as { since: Date; limit: number };
    expect(arg.since.getTime()).toBe(new Date('2026-03-04T12:00:00Z').getTime() - OVERLAP_MS);
    expect(arg.limit).toBe(PAGE_LIMIT);
  });

  test('advances the cursor to the wall clock on a complete read, so an idle store stops re-syncing', async () => {
    const { runOrderSync, repos } = await load({
      cursor: new Date('2026-03-04T12:00:00Z'),
      // Newest order is months old and there is nothing after it.
      orders: [order('o3', '2026-03-04T12:30:00Z')],
    });
    const before = Date.now();
    const res = await runOrderSync('s1');
    const marked = vi.mocked(repos.connectionRepo.markOrdersSynced).mock.calls[0][1] as Date;
    expect(marked.getTime()).toBeGreaterThanOrEqual(before);
    expect(res.truncated).toBe(false);
    expect(new Date(res.cursor!).getTime()).toBe(marked.getTime());
  });

  test('sets a cursor even when the store has never taken an order', async () => {
    const { runOrderSync, repos } = await load({ orders: [], cursor: null });
    const res = await runOrderSync('s1');
    const marked = vi.mocked(repos.connectionRepo.markOrdersSynced).mock.calls[0][1] as Date;
    expect(marked).toBeInstanceOf(Date);
    expect(res.imported).toBe(0);
    expect(res.cursor).not.toBeNull();
  });

  test('keeps the cursor at the newest order read when the page was truncated', async () => {
    const newest = new Date('2026-03-04T12:00:00Z');
    const newestIso = newest.toISOString();
    const { runOrderSync, repos } = await load({
      cursor: new Date('2026-01-01T00:00:00Z'),
      orders: Array.from({ length: PAGE_LIMIT }, (_, i) => order(`o${i}`, `2026-02-01T00:00:00Z`)).map((o, i) =>
        i === 0 ? o : { ...o, placedAt: newest },
      ),
    });
    const res = await runOrderSync('s1');
    expect(res.truncated).toBe(true);
    const marked = vi.mocked(repos.connectionRepo.markOrdersSynced).mock.calls[0][1] as Date;
    expect(marked.toISOString()).toBe(newestIso);
    expect(res.cursor).toBe(newestIso);
  });

  test('rolls up the span the backfill touched, measured back from today', async () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString();
    const { runOrderSync, analytics } = await load({
      orders: [order('old', sixDaysAgo), order('new', new Date().toISOString())],
    });
    await runOrderSync('s1');
    expect(analytics.rollupDailyMetrics).toHaveBeenCalledWith('s1', expect.any(Number));
    const days = vi.mocked(analytics.rollupDailyMetrics).mock.calls[0][1] as number;
    expect(days).toBeGreaterThanOrEqual(3);
    expect(days).toBeLessThanOrEqual(90);
  });

  test('clamps a very long history to the 90-day rollup window', async () => {
    const yearAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const { runOrderSync, analytics } = await load({ orders: [order('ancient', yearAgo)] });
    await runOrderSync('s1');
    expect(analytics.rollupDailyMetrics).toHaveBeenCalledWith('s1', 90);
  });

  test('skips the rollup when no order carries a placedAt', async () => {
    const { runOrderSync, analytics } = await load({ orders: [order('undated', null)] });
    await runOrderSync('s1');
    expect(analytics.rollupDailyMetrics).not.toHaveBeenCalled();
  });

  test('propagates an adapter failure so the job can retry', async () => {
    const { runOrderSync, repos } = await load({
      adapter: { listOrders: vi.fn().mockRejectedValue(new Error('rate limited')) },
    });
    await expect(runOrderSync('s1')).rejects.toThrow(/rate limited/);
    expect(repos.connectionRepo.markOrdersSynced).not.toHaveBeenCalled();
  });
});

describe('runOrderSync attribution', () => {
  test('attributes every imported order, so a manual-token store earns conversions', async () => {
    const { runOrderSync, analytics } = await load({
      orders: [order('o1', '2026-01-05T10:00:00Z'), order('o2', '2026-01-06T10:00:00Z')],
    });
    const res = await runOrderSync('s1');
    const ids = vi.mocked(analytics.markConversionsForOrder).mock.calls.map((c) => (c[1] as Order).id);
    expect(ids).toEqual(['o1', 'o2']);
    expect(res.attributed).toBe(0);
  });

  test('reports how many rows were converted', async () => {
    const { runOrderSync, analytics } = await load({ orders: [order('o1', null), order('o2', null)] });
    vi.mocked(analytics.markConversionsForOrder).mockResolvedValue(2 as never);
    expect((await runOrderSync('s1')).attributed).toBe(4);
  });

  test('isolates an attribution failure to its own order instead of aborting the import', async () => {
    const { runOrderSync, analytics, repos } = await load({
      orders: [order('o1', '2026-01-05T10:00:00Z'), order('o2', '2026-01-06T10:00:00Z')],
    });
    vi.mocked(analytics.markConversionsForOrder)
      .mockRejectedValueOnce(new Error('join failed'))
      .mockResolvedValue(3 as never);
    const res = await runOrderSync('s1');
    // Both orders still land, and the good one still attributes.
    expect(repos.orderRepo.upsert).toHaveBeenCalledTimes(2);
    expect(analytics.markConversionsForOrder).toHaveBeenCalledTimes(2);
    expect(res.attributed).toBe(3);
    expect(res.imported).toBe(2);
  });

  test('still advances the cursor when every attribution fails', async () => {
    const { runOrderSync, analytics, repos } = await load({ orders: [order('o1', '2026-01-05T10:00:00Z')] });
    vi.mocked(analytics.markConversionsForOrder).mockRejectedValue(new Error('down'));
    const res = await runOrderSync('s1');
    expect(res.attributed).toBe(0);
    expect(res.cursor).not.toBeNull();
    expect(repos.connectionRepo.markOrdersSynced).toHaveBeenCalled();
  });
});

describe('order.sync job handler', () => {
  test('threads a valid payload since through to the adapter', async () => {
    const { jobHandlers, listOrders } = await load({
      cursor: new Date('2026-01-01T00:00:00Z'),
      orders: [order('o1', '2026-03-01T00:00:00Z')],
    });
    await jobHandlers['order.sync']('s1', { since: '2026-03-01T00:00:00.000Z' });
    const arg = listOrders.mock.calls[0][0] as { since: Date };
    expect(arg.since.getTime()).toBe(new Date('2026-03-01T00:00:00Z').getTime() - OVERLAP_MS);
  });

  test('falls back to the stored cursor when the payload since is missing or unparseable', async () => {
    const stored = new Date('2026-01-01T00:00:00Z');
    for (const payload of [null, {}, { since: 'not-a-date' }]) {
      const { jobHandlers, listOrders } = await load({ cursor: stored, orders: [] });
      await jobHandlers['order.sync']('s1', payload);
      const arg = listOrders.mock.calls[0][0] as { since: Date };
      expect(arg.since.getTime()).toBe(stored.getTime() - OVERLAP_MS);
    }
  });
});
