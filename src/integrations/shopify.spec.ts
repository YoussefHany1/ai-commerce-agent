import { describe, expect, test, vi, afterEach } from 'vitest';
import { ShopifyAdapter, mapShopifyOrderNode } from './shopify.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function orderNode(over: Record<string, unknown> = {}) {
  return {
    id: 'gid://shopify/Order/1',
    createdAt: '2026-03-04T10:00:00Z',
    displayFinancialStatus: 'PAID',
    // currencyCode, not currency: MoneyV2 has no `currency` field, and an
    // unknown field fails the whole query at validation time.
    currentTotalPriceSet: { shopMoney: { amount: '199.00', currencyCode: 'SAR' } },
    customer: { displayName: 'Sara', email: 's@example.com', phone: '0551234567' },
    displayFulfillmentStatus: 'FULFILLED',
    ...over,
  };
}

describe('mapShopifyOrderNode', () => {
  test('maps amount, currency, customer and placedAt', () => {
    const o = mapShopifyOrderNode(orderNode());
    expect(o.id).toBe('gid://shopify/Order/1');
    expect(o.total).toBe(199);
    expect(o.currency).toBe('SAR');
    expect(o.paymentStatus).toBe('PAID');
    expect(o.status).toBe('FULFILLED');
    expect(o.customer?.name).toBe('Sara');
    expect(o.placedAt?.toISOString()).toBe('2026-03-04T10:00:00.000Z');
  });

  test('records revenue as zero rather than NaN when the price set is missing', () => {
    const o = mapShopifyOrderNode(orderNode({ currentTotalPriceSet: null }));
    expect(o.total).toBe(0);
    expect(o.currency).toBe('SAR');
  });

  test('leaves placedAt undefined for an unparseable createdAt', () => {
    const o = mapShopifyOrderNode(orderNode({ createdAt: 'not-a-date' }));
    expect(o.placedAt).toBeUndefined();
  });
});

describe('shopify listOrders backfill', () => {
  test('pages with a cursor and stops on the last page', async () => {
    const pages = [
      [orderNode({ id: 'a', createdAt: '2026-03-03T10:00:00Z' })],
      [orderNode({ id: 'b', createdAt: '2026-03-02T10:00:00Z' })],
    ];
    let call = 0;
    const seen: string[] = [];
    const cursors: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          variables: Record<string, unknown>;
          query: string;
        };
        seen.push(String(body.variables.first));
        cursors.push(body.variables.after);
        const nodes = pages[call] ?? [];
        call++;
        return {
          ok: true,
          async json() {
            return {
              data: {
                orders: {
                  pageInfo: { hasNextPage: call < pages.length, endCursor: `cur-${call}` },
                  nodes,
                },
              },
            };
          },
        } as Response;
      }),
    );

    const adapter = new ShopifyAdapter('demo.myshopify.com', 'tok');
    const orders = await adapter.listOrders();
    expect(orders.map((o) => o.id)).toEqual(['a', 'b']);
    // Both pages were requested at the full page size, and the cursor from page one
    // was threaded into page two's query.
    expect(seen).toEqual(['100', '100']);
    expect(cursors).toEqual([null, 'cur-1']);
  });

  test('passes a created_at lower bound to the `query` argument, not a `search` field', async () => {
    let query: string | undefined;
    let variables: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
        query = body.query;
        variables = body.variables;
        expect(String(url)).toContain('/admin/api/');
        return {
          ok: true,
          async json() {
            return { data: { orders: { pageInfo: { hasNextPage: false }, nodes: [] } } };
          },
        } as Response;
      }),
    );

    const adapter = new ShopifyAdapter('demo.myshopify.com', 'tok');
    await adapter.listOrders({ since: new Date('2026-01-01T00:00:00Z') });
    // OrderConnection has no `search:` argument; an unknown argument fails validation.
    expect(query).not.toContain('search:');
    expect(query).toContain('query:$query');
    expect(variables?.query).toBe('created_at:>=2026-01-01T00:00:00.000Z');
  });

  test('sends a null query variable when no lower bound is given', async () => {
    let variables: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        variables = (JSON.parse(String(init?.body)) as { variables: Record<string, unknown> }).variables;
        return {
          ok: true,
          async json() {
            return { data: { orders: { pageInfo: { hasNextPage: false }, nodes: [] } } };
          },
        } as Response;
      }),
    );
    const adapter = new ShopifyAdapter('demo.myshopify.com', 'tok');
    await adapter.listOrders();
    expect(variables?.query).toBeNull();
  });

  test('requests currencyCode rather than the non-existent currency field', async () => {
    let query: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        query = (JSON.parse(String(init?.body)) as { query: string }).query;
        return {
          ok: true,
          async json() {
            return { data: { orders: { pageInfo: { hasNextPage: false }, nodes: [] } } };
          },
        } as Response;
      }),
    );
    const adapter = new ShopifyAdapter('demo.myshopify.com', 'tok');
    await adapter.listOrders();
    expect(query).toContain('shopMoney{amount currencyCode}');
    expect(query).not.toMatch(/shopMoney\{amount currency\}/);
  });

  test('drops orders at or after until, since the search bound is one-sided', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        async json() {
          return {
            data: {
              orders: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  orderNode({ id: 'inside', createdAt: '2026-03-02T10:00:00Z' }),
                  orderNode({ id: 'future', createdAt: '2026-06-01T10:00:00Z' }),
                ],
              },
            },
          };
        },
      }) as Response),
    );

    const adapter = new ShopifyAdapter('demo.myshopify.com', 'tok');
    const orders = await adapter.listOrders({ until: new Date('2026-05-01T00:00:00Z') });
    expect(orders.map((o) => o.id)).toEqual(['inside']);
  });

  test('surfaces a GraphQL error instead of returning a short page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        async json() {
          return { errors: [{ message: 'Access denied' }] };
        },
      }) as Response),
    );
    const adapter = new ShopifyAdapter('demo.myshopify.com', 'tok');
    await expect(adapter.listOrders()).rejects.toThrow(/Access denied/);
  });
});
