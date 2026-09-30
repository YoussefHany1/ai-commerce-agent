import { describe, expect, test, vi, beforeEach } from 'vitest';

/**
 * `recordImpressions` is what gives the funnel a denominator.
 *
 * Until rows existed before a click, `recommended` and `clicked` were the same
 * number and CTR was pinned at 100%. These tests pin the behaviour that fixes that:
 * a row is written at recommendation time with no `clickedAt`, re-recommending the
 * same product does not inflate the count, and a click updates the existing row
 * rather than creating a second one.
 */

/** Records the values passed to `insert().values()` and every update. */
const state = {
  conversation: { id: 'c1', channel: 'web' } as { id: string; channel: string | null } | null,
  existing: [] as { id?: string; productId: string }[],
  inserted: [] as Record<string, unknown>[],
  updated: [] as Record<string, unknown>[],
};

/**
 * Both functions read the conversation first and the existing rows second, so
 * selects are answered by call index. Rows are computed on read rather than
 * captured, so a test can mutate `state` freely and the mock follows.
 */
let selectCalls = 0;
/** Set by tests that need the second select (the existing-rows read) to differ. */
let existingOverride: { id?: string; productId: string }[] | null = null;

function rowsFor(index: number): unknown[] {
  if (index === 0) return [state.conversation].filter(Boolean);
  return existingOverride ?? state.existing;
}

const tx = {
  select: vi.fn(() => {
    const index = selectCalls;
    selectCalls += 1;
    return {
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rowsFor(index)),
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rowsFor(index)).then(resolve),
        }),
      }),
    };
  }),
  insert: vi.fn(() => ({
    values: (rows: Record<string, unknown>[] | Record<string, unknown>) => {
      state.inserted.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve();
    },
  })),
  update: vi.fn(() => ({
    set: (v: Record<string, unknown>) => {
      state.updated.push(v);
      return { where: () => Promise.resolve() };
    },
  })),
};

vi.mock('../db/client.js', () => ({
  withTenant: vi.fn(async (_storeId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx)),
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.conversation = { id: 'c1', channel: 'web' };
  state.existing = [];
  state.inserted = [];
  state.updated = [];
  selectCalls = 0;
  existingOverride = null;
});

async function load() {
  return import('./analytics.js');
}

describe('recordImpressions', () => {
  test('writes one row per recommended product, with no clickedAt', async () => {
    const { recordImpressions } = await load();
    const n = await recordImpressions('s1', { conversationId: 'c1', productIds: ['p1', 'p2'] });
    expect(n).toBe(2);
    expect(state.inserted).toEqual([
      { storeId: 's1', conversationId: 'c1', productId: 'p1', channel: 'web' },
      { storeId: 's1', conversationId: 'c1', productId: 'p2', channel: 'web' },
    ]);
    // The absence of clickedAt is the entire point: it is what makes the row count
    // as "recommended" but not "clicked" in the funnel query.
    expect(Object.keys(state.inserted[0]!)).not.toContain('clickedAt');
  });

  test('carries the conversation’s channel, so a widget recommendation is not filed as web traffic from elsewhere', async () => {
    state.conversation = { id: 'c1', channel: 'whatsapp' };
    const { recordImpressions } = await load();
    await recordImpressions('s1', { conversationId: 'c1', productIds: ['p1'] });
    expect(state.inserted[0]!.channel).toBe('whatsapp');
  });

  test('de-duplicates within a single call', async () => {
    const { recordImpressions } = await load();
    const n = await recordImpressions('s1', { conversationId: 'c1', productIds: ['p1', 'p1', 'p2'] });
    expect(n).toBe(2);
    expect(state.inserted).toHaveLength(2);
  });

  test('does not re-insert a product already recorded in this conversation', async () => {
    state.existing = [{ productId: 'p1' }];
    const { recordImpressions } = await load();
    const n = await recordImpressions('s1', { conversationId: 'c1', productIds: ['p1', 'p2'] });
    // Re-recommending p1 must not inflate the denominator.
    expect(n).toBe(1);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]!.productId).toBe('p2');
  });

  test('ignores empty and falsy ids rather than inserting a blank product', async () => {
    const { recordImpressions } = await load();
    expect(await recordImpressions('s1', { conversationId: 'c1', productIds: [] })).toBe(0);
    expect(await recordImpressions('s1', { conversationId: 'c1', productIds: ['', 'p1'] })).toBe(1);
    expect(state.inserted.map((r) => r.productId)).toEqual(['p1']);
  });

  test('writes nothing for an unknown conversation', async () => {
    state.conversation = null;
    const { recordImpressions } = await load();
    expect(await recordImpressions('s1', { conversationId: 'missing', productIds: ['p1'] })).toBe(0);
    expect(state.inserted).toHaveLength(0);
  });

  test('falls back to web for a conversation with no channel recorded', async () => {
    state.conversation = { id: 'c1', channel: null };
    const { recordImpressions } = await load();
    await recordImpressions('s1', { conversationId: 'c1', productIds: ['p1'] });
    expect(state.inserted[0]!.channel).toBe('web');
  });
});

describe('recordClick after an impression', () => {
  test('fills in the existing recommendation row instead of creating a duplicate', async () => {
    // The impression already wrote the row; the click must update it.
    existingOverride = [{ id: 'a1', productId: 'p1' }];
    const { recordClick } = await load();
    const ok = await recordClick('s1', { conversationId: 'c1', productId: 'p1' });
    expect(ok).toBe(true);
    expect(state.inserted).toHaveLength(0);
    // A duplicate row would double-count one click and push CTR above 100%.
    expect(state.updated).toHaveLength(1);
    expect(state.updated[0]!.clickedAt).toBeInstanceOf(Date);
  });

  test('inserts when the recommendation was never recorded, e.g. an older click', async () => {
    existingOverride = [];
    const { recordClick } = await load();
    expect(await recordClick('s1', { conversationId: 'c1', productId: 'p1' })).toBe(true);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]!.clickedAt).toBeInstanceOf(Date);
  });

  test('rejects a click on a conversation in another store', async () => {
    state.conversation = null;
    const { recordClick } = await load();
    expect(await recordClick('s1', { conversationId: 'missing', productId: 'p1' })).toBe(false);
    expect(state.inserted).toHaveLength(0);
  });
});
