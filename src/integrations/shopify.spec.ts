import { describe, expect, test, vi, afterEach, beforeEach } from 'vitest';
import { ShopifyAdapter, mapShopifyOrderNode } from './shopify.js';
import { logger } from '../lib/logger.js';

vi.mock('../lib/logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
});

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

/**
 * `orders.nodes.customer` is gated behind the `read_customers` access scope, and
 * a token without it gets ACCESS_DENIED for the whole query rather than a null
 * field. Left unhandled that kills every order sync, which is what left the
 * dashboard at zero.
 */
const CUSTOMER_DENIED = [
  {
    message: 'Access denied for customer field. Required access: `read_customers` access scope.',
    extensions: { code: 'ACCESS_DENIED', requiredAccess: '`read_customers` access scope.' },
    path: ['orders', 'nodes', 0, 'customer'],
  },
];

describe('shopify customer scope fallback', () => {
  test('retries without the customer selection and still imports the orders', async () => {
    const queries: string[] = [];
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        queries.push(body.query);
        call++;
        if (body.query.includes('customer{')) {
          return { ok: true, async json() { return { errors: CUSTOMER_DENIED }; } } as Response;
        }
        return {
          ok: true,
          async json() {
            return {
              data: {
                orders: {
                  pageInfo: { hasNextPage: false },
                  nodes: [{ ...orderNode({ id: 'kept' }), customer: undefined }],
                },
              },
            };
          },
        } as Response;
      }),
    );

    const orders = await new ShopifyAdapter('demo.myshopify.com', 'tok').listOrders();
    expect(orders.map((o) => o.id)).toEqual(['kept']);
    // Revenue and the placement date survive; only the customer is lost.
    expect(orders[0]?.total).toBe(199);
    expect(orders[0]?.placedAt?.toISOString()).toBe('2026-03-04T10:00:00.000Z');
    expect(orders[0]?.customer?.phone).toBeUndefined();
    expect(queries).toHaveLength(2);
    expect(queries[1]).not.toContain('customer{');
  });

  test('warns that orders will sync without a customer, so a dead automation is diagnosable', async () => {
    // The silent part of this fallback is what made an `order_placed` rule look broken:
    // sync reported success, every order had a null customer, and the rule matched
    // nothing because there was no phone to send to. Nobody could tell from the logs.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes('customer{')) {
          return { ok: true, async json() { return { errors: CUSTOMER_DENIED }; } } as Response;
        }
        return {
          ok: true,
          async json() {
            return {
              data: {
                orders: {
                  pageInfo: { hasNextPage: false },
                  nodes: [{ ...orderNode({ id: 'kept' }), customer: undefined }],
                },
              },
            };
          },
        } as Response;
      }),
    );

    await new ShopifyAdapter('demo.myshopify.com', 'tok').listOrders();

    expect(logger.warn).toHaveBeenCalled();
    const [payload, msg] = vi.mocked(logger.warn).mock.calls[0] as [{ shop: string }, string];
    expect(payload.shop).toBe('demo.myshopify.com');
    expect(msg).toMatch(/read_customers/);
    expect(msg).toMatch(/order_placed/);
  });

  test('drops the field for the rest of the process once the scope is known missing', async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        queries.push(body.query);
        if (body.query.includes('customer{')) {
          return { ok: true, async json() { return { errors: CUSTOMER_DENIED }; } } as Response;
        }
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
    await adapter.listOrders();
    // The second sync must not re-spend a failed request re-probing the scope.
    expect(queries.filter((q) => q.includes('customer{'))).toHaveLength(1);
  });

  test('getOrder degrades the same way', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        if (call === 1) return { ok: true, async json() { return { errors: CUSTOMER_DENIED }; } } as Response;
        return { ok: true, async json() { return { data: { order: { ...orderNode({ id: 'o1' }), customer: undefined } } }; } } as Response;
      }),
    );
    const o = await new ShopifyAdapter('demo.myshopify.com', 'tok').getOrder('gid://shopify/Order/1');
    expect(o?.id).toBe('o1');
    expect(o?.total).toBe(199);
  });

  test('still fails loudly on an error that is not a customer scope problem', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        call++;
        return { ok: true, async json() { return { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }; } } as Response;
      }),
    );
    await expect(new ShopifyAdapter('demo.myshopify.com', 'tok').listOrders()).rejects.toThrow(/Throttled/);
    expect(call).toBe(1);
  });
});
