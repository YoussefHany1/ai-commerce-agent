import { test, expect, describe, vi, beforeEach } from 'vitest';

/**
 * rlsPing is the check that decides whether the container reports healthy, so its
 * decision table is worth pinning without needing a live database. The mock stands
 * in for db/client.js and returns whatever catalog rows a case needs.
 *
 * The behaviour under test is the one that was missing before: `relrowsecurity`
 * alone passed for a table owner, who bypasses RLS unless it is also FORCED, and
 * only `stores` was inspected, so the other 16 tables could be unprotected.
 */

const TABLE_COUNT = 17;

type Row = { name: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owned: boolean };

const ALL_TABLES = [
  'clients',
  'operators',
  'stores',
  'platform_connections',
  'products',
  'variants',
  'customers',
  'orders',
  'conversations',
  'messages',
  'events',
  'automation_rules',
  'automation_logs',
  'jobs',
  'attributions',
  'whatsapp_channels',
  'billing_subscriptions',
  'daily_metrics',
];

function catalog(over: Partial<Row> = {}): Row[] {
  return ALL_TABLES.map((name) => ({
    name,
    relrowsecurity: true,
    relforcerowsecurity: true,
    owned: false,
    ...over,
  }));
}

let rows: Row[] = [];

// vi.mock factories are hoisted above the declarations they close over, so the
// spy has to be created through vi.hoisted.
const { sqlMock } = vi.hoisted(() => ({ sqlMock: vi.fn() }));

vi.mock('../db/client.js', () => ({ sql: sqlMock }));

const { rlsPing } = await import('./health.js');

describe('rlsPing', () => {
  beforeEach(() => {
    rows = catalog();
    sqlMock.mockReset();
    sqlMock.mockImplementation(() => Promise.resolve(rows));
  });

  test('passes when every table is enabled, forced, and unowned', async () => {
    expect(await rlsPing()).toBe(true);
  });

  test('fails when a table is enabled but not forced (the owner-bypass hole)', async () => {
    rows = catalog({ relforcerowsecurity: false });
    expect(await rlsPing()).toBe(false);
  });

  test('fails when the connected role owns the tables', async () => {
    rows = catalog({ owned: true });
    expect(await rlsPing()).toBe(false);
  });

  test('fails when a table has RLS disabled outright', async () => {
    rows = catalog({ relrowsecurity: false });
    expect(await rlsPing()).toBe(false);
  });

  test('fails when a table is missing, so the verified set cannot silently shrink', async () => {
    rows = catalog().slice(0, TABLE_COUNT - 1);
    expect(await rlsPing()).toBe(false);
  });

  test('fails on an empty result rather than passing vacuously', async () => {
    rows = [];
    expect(await rlsPing()).toBe(false);
  });

  test('fails closed when the database is unreachable', async () => {
    // Not mockImplementationOnce: rlsPing calls sql(RLS_TABLES) to build the IN
    // list before it runs the query, so a one-shot rejection is consumed by the
    // helper and the query still succeeds.
    sqlMock.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
    expect(await rlsPing()).toBe(false);
  });
});
