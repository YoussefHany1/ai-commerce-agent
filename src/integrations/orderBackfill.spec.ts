import { describe, expect, test, vi, afterEach } from 'vitest';
import { SallaAdapter, mapSallaOrder } from './salla.js';
import { ZidAdapter, mapZidOrder } from './zid.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Salla documents `per_page=30` as the maximum page size for orders. */
const SALLA_PER_PAGE = 30;
/** Zid's order collection is paged with `per_page`; 100 is what the SDK uses. */
const ZID_PER_PAGE = 100;

/**
 * `List Orders` response as published at https://docs.salla.dev/api-5394146:
 * `data` is a bare array, the placement date is `date.date`, the total is
 * `total.amount`, and `payment_method` is a string.
 */
function sallaOrderNode(over: Record<string, unknown> = {}) {
  return {
    id: 1333249299,
    reference_id: 275839672,
    total: { amount: '16.39', currency: 'SAR' },
    date: { date: '2026-08-02 18:08:47.000000', timezone_type: 3, timezone: 'Asia/Riyadh' },
    status: { id: 1939592358, name: 'قيد التنفيذ', slug: 'in_progress' },
    payment_method: 'credit_card',
    payment_methods: [{ payment_method: 'credit_card', amount: '16.39' }],
    customer: {
      id: 19946325555,
      full_name: 'Mohammed Ahmed',
      first_name: 'Mohammed',
      last_name: 'Ahmed',
      mobile: 557777777,
      mobile_code: '+966',
      email: 'test-email@gmail.com',
    },
    ...over,
  };
}

/** n Salla order nodes, all sharing one placement timestamp. */
function sallaRun(prefix: string, n: number, date: string) {
  return Array.from({ length: n }, (_, i) =>
    sallaOrderNode({ id: `${prefix}${i}`, date: { date, timezone: 'Asia/Riyadh' } }),
  );
}

describe('mapSallaOrder', () => {
  test('reads the total and currency from the documented `total` object', () => {
    // Reading `amounts.total.amount` here, as the adapter once did, yields 0 for
    // every Salla order because that wrapper does not exist in the API.
    const o = mapSallaOrder(sallaOrderNode());
    expect(o.total).toBe(16.39);
    expect(o.currency).toBe('SAR');
  });

  test('reads the string `payment_method` and the documented status', () => {
    const o = mapSallaOrder(sallaOrderNode());
    expect(o.paymentStatus).toBe('credit_card');
    expect(o.status).toBe('قيد التنفيذ');
  });

  test('parses the offset-free date.date as Riyadh local time', () => {
    // 18:08:47 in Asia/Riyadh is 15:08:47Z. Resolved against a UTC host it
    // would land three hours late, and after 21:00 local on the wrong day.
    const o = mapSallaOrder(sallaOrderNode());
    expect(o.placedAt?.toISOString()).toBe('2026-08-02T15:08:47.000Z');
  });

  test('falls back to created_at when the date object is absent', () => {
    const o = mapSallaOrder(sallaOrderNode({ date: undefined, created_at: '2026-03-04 10:00:00' }));
    expect(o.placedAt?.toISOString()).toBe('2026-03-04T07:00:00.000Z');
  });

  test('leaves placedAt undefined when no timestamp is present', () => {
    const { date, ...without } = sallaOrderNode();
    void date;
    expect(mapSallaOrder(without).placedAt).toBeUndefined();
  });

  test('resolves an unparseable total to 0 instead of NaN', () => {
    expect(mapSallaOrder(sallaOrderNode({ total: { amount: 'n/a', currency: 'SAR' } })).total).toBe(0);
  });

  test('stringifies the numeric customer mobile', () => {
    expect(mapSallaOrder(sallaOrderNode()).customer?.phone).toBe('557777777');
  });
});

describe('salla listOrders', () => {
  let calls: URL[];

  function stub(pages: unknown[][]) {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = new URL(url);
        calls.push(u);
        const page = Number(u.searchParams.get('page') ?? '1');
        return {
          ok: true,
          async json() {
            return {
              status: 200,
              success: true,
              data: pages[page - 1] ?? [],
              pagination: { count: SALLA_PER_PAGE, total: 4096, perPage: SALLA_PER_PAGE },
            };
          },
        } as Response;
      }),
    );
  }

  test('asks for the documented maximum page size and keeps paging past a full page', async () => {
    stub([sallaRun('a', SALLA_PER_PAGE, '2026-03-10 10:00:00'), sallaRun('b', SALLA_PER_PAGE, '2026-03-09 10:00:00'), [sallaOrderNode({ id: 'last' })]]);
    const orders = await new SallaAdapter('tok').listOrders();
    expect(calls[0]?.searchParams.get('per_page')).toBe('30');
    expect(orders).toHaveLength(SALLA_PER_PAGE * 2 + 1);
    expect(calls).toHaveLength(3);
  });

  test('sends the server-side from_date and to_date filters', async () => {
    stub([[]]);
    await new SallaAdapter('tok').listOrders({
      since: new Date('2026-03-04T00:00:00Z'),
      until: new Date('2026-03-10T00:00:00Z'),
    });
    // since is widened by a day because the filter is a calendar date; the exact
    // timestamp boundary is re-applied client-side.
    expect(calls[0]?.searchParams.get('from_date')).toBe('2026-03-03');
    expect(calls[0]?.searchParams.get('to_date')).toBe('2026-03-10');
  });

  test('omits date filters when unbounded', async () => {
    stub([[]]);
    await new SallaAdapter('tok').listOrders();
    expect(calls[0]?.searchParams.get('from_date')).toBeNull();
    expect(calls[0]?.searchParams.get('to_date')).toBeNull();
  });

  test('pages to the end of the window instead of assuming a sort order', async () => {
    // Page 1 is entirely older than the bound. On an oldest-first collection the
    // old newest-first exit would stop here and import nothing at all.
    stub([
      sallaRun('old', SALLA_PER_PAGE, '2026-01-01 10:00:00'),
      sallaRun('new', SALLA_PER_PAGE, '2026-03-05 10:00:00'),
      [sallaOrderNode({ id: 'newest', date: { date: '2026-03-10 10:00:00', timezone: 'Asia/Riyadh' } })],
    ]);
    const orders = await new SallaAdapter('tok').listOrders({ since: new Date('2026-03-04T00:00:00Z') });
    expect(orders).toHaveLength(SALLA_PER_PAGE + 1);
    expect(orders.some((o) => o.id === 'old0')).toBe(false);
    expect(orders.at(-1)?.id).toBe('newest');
    expect(calls).toHaveLength(3);
  });

  test('drops orders outside the since/until window', async () => {
    stub([
      [
        sallaOrderNode({ id: 'future', date: { date: '2026-04-01 10:00:00', timezone: 'Asia/Riyadh' } }),
        ...sallaRun('mid', SALLA_PER_PAGE - 2, '2026-03-05 10:00:00'),
        sallaOrderNode({ id: 'stale', date: { date: '2026-02-01 10:00:00', timezone: 'Asia/Riyadh' } }),
      ],
    ]);
    const orders = await new SallaAdapter('tok').listOrders({
      since: new Date('2026-03-04T00:00:00Z'),
      until: new Date('2026-03-10T00:00:00Z'),
    });
    expect(orders.every((o) => o.id !== 'future' && o.id !== 'stale')).toBe(true);
    expect(orders).toHaveLength(SALLA_PER_PAGE - 2);
  });

  test('respects the limit and stops mid-page', async () => {
    stub([sallaRun('a', SALLA_PER_PAGE, '2026-03-05 10:00:00'), sallaRun('b', SALLA_PER_PAGE, '2026-03-04 10:00:00')]);
    const orders = await new SallaAdapter('tok').listOrders({ limit: 5 });
    expect(orders).toHaveLength(5);
    expect(calls).toHaveLength(1);
  });
});

/**
 * `List Orders` response as published at https://docs.zid.sa/list-of-orders: a
 * top-level `orders` array, an offset-free `created_at`, a string `order_total`
 * and a string `payment_status`.
 */
function zidOrderNode(over: Record<string, unknown> = {}) {
  return {
    id: 60407024,
    invoice_number: 60407024,
    code: 'YMK3VPgkhy',
    currency_code: 'SAR',
    order_status: { name: 'جديد', code: 'new' },
    display_status: { id: 1, code: 'new', color: '#3498db', name: 'جديد' },
    customer: { id: 1441, name: 'John Doe', email: 'test@mail.com', mobile: '966123456789' },
    order_total: '124.15',
    order_total_string: '124.15 SAR',
    payment_status: 'pending',
    created_at: '2025-11-12 08:57:35',
    updated_at: '2026-01-26 07:18:19',
    ...over,
  };
}

/** n Zid order nodes, all sharing one placement timestamp. */
function zidRun(prefix: string, n: number, createdAt: string) {
  return Array.from({ length: n }, (_, i) => zidOrderNode({ id: `${prefix}${i}`, created_at: createdAt }));
}

/** n Zid order nodes whose timestamps strictly increase with `i` (oldest first). */
function zidRunAscending(prefix: string, n: number, startIso: string) {
  const start = new Date(startIso).getTime();
  return Array.from({ length: n }, (_, i) => {
    const at = new Date(start + i * 60_000);
    return zidOrderNode({ id: `${prefix}${i}`, created_at: at.toISOString().replace('T', ' ').slice(0, 19) });
  });
}

describe('mapZidOrder', () => {
  test('parses the offset-free created_at as Riyadh local time', () => {
    // 08:57:35 in Asia/Riyadh is 05:57:35Z.
    expect(mapZidOrder(zidOrderNode()).placedAt?.toISOString()).toBe('2025-11-12T05:57:35.000Z');
  });

  test('falls back to created_date', () => {
    const { created_at, ...rest } = zidOrderNode();
    void created_at;
    expect(mapZidOrder({ ...rest, created_date: '2026-02-02 00:00:00' }).placedAt?.toISOString()).toBe(
      '2026-02-01T21:00:00.000Z',
    );
  });

  test('leaves placedAt undefined when neither timestamp is present', () => {
    const { created_at, ...rest } = zidOrderNode();
    void created_at;
    expect(mapZidOrder(rest).placedAt).toBeUndefined();
  });

  test('parses the string order_total and the string payment_status', () => {
    const o = mapZidOrder(zidOrderNode());
    expect(o.total).toBe(124.15);
    expect(o.paymentStatus).toBe('pending');
    expect(o.status).toBe('جديد');
  });

  test('parses the high-precision string order_total', () => {
    expect(mapZidOrder(zidOrderNode({ order_total: '6954.63998402370000' })).total).toBe(6954.6399840237);
  });

  test('never parses the localized order_total_string', () => {
    // On the view endpoint that field is "6,954.64 ج.م"; parseFloat stops at the
    // thousands separator and reports 6, which would look like a real order value.
    expect(mapZidOrder(zidOrderNode({ order_total: '', order_total_string: '6,954.64 ج.م' })).total).toBe(0);
    expect(mapZidOrder(zidOrderNode({ order_total: null, order_total_string: '' })).total).toBe(0);
  });
});

describe('zid getOrder', () => {
  test('uses the /view route and reads the singular order envelope', async () => {
    // There is no GET /managers/store/orders/{id} route at all, and the order
    // is not at the top level of the response.
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        seen.push(new URL(url).pathname);
        return {
          ok: true,
          async json() {
            return {
              status: 'object',
              order: zidOrderNode({ id: 60407024, created_at: '2026-04-21 15:12:07' }),
              message: { type: 'object', code: null, name: null, description: null },
            };
          },
        } as Response;
      }),
    );
    const o = await new ZidAdapter('access', 'auth').getOrder('60407024');
    expect(seen[0]).toBe('/v1/managers/store/orders/60407024/view');
    expect(o?.id).toBe('60407024');
    expect(o?.placedAt?.toISOString()).toBe('2026-04-21T12:12:07.000Z');
  });

  test('returns null when the envelope carries no order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, async json() { return { status: 'error' }; } }) as Response),
    );
    expect(await new ZidAdapter('access', 'auth').getOrder('nope')).toBeNull();
  });
});

describe('zid listOrders', () => {
  let calls: URL[];

  /** Stubs the documented top-level `orders` envelope. */
  function stub(pages: unknown[][]) {
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = new URL(url);
        calls.push(u);
        const page = Number(u.searchParams.get('page') ?? '1');
        return { ok: true, async json() { return { status: 'object', orders: pages[page - 1] ?? [] }; } } as Response;
      }),
    );
  }

  test('reads the top-level orders array', async () => {
    // The orders sit at the top level; looking only for `results` or `data`, as
    // the adapter once did, returns nothing at all.
    stub([[zidOrderNode({ id: 'only' })]]);
    const orders = await new ZidAdapter('access', 'auth').listOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.id).toBe('only');
  });

  test('also accepts results and data envelopes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = new URL(url);
        calls.push(u);
        return { ok: true, async json() { return { success: true, data: { results: [zidOrderNode({ id: 'wrapped' })] } }; } } as Response;
      }),
    );
    expect((await new ZidAdapter('access', 'auth').listOrders())[0]?.id).toBe('wrapped');
  });

  test('pages with per_page against the manager orders path', async () => {
    stub([[]]);
    await new ZidAdapter('access', 'auth').listOrders();
    const first = calls[0]!;
    expect(first.pathname).toContain('/managers/store/orders');
    expect(first.searchParams.get('per_page')).toBe('100');
    // page_size belongs to Zid's account endpoints, not the manager collection.
    expect(first.searchParams.get('page_size')).toBeNull();
  });

  test('exits early once a newest-first page walks past since', async () => {
    stub([
      zidRun('a', ZID_PER_PAGE, '2026-03-10 10:00:00'),
      [...zidRun('b', ZID_PER_PAGE - 1, '2026-03-05 10:00:00'), zidOrderNode({ id: 'old', created_at: '2026-01-01 10:00:00' })],
      zidRun('c', ZID_PER_PAGE, '2025-12-01 10:00:00'),
    ]);
    const orders = await new ZidAdapter('access', 'auth').listOrders({ since: new Date('2026-03-04T00:00:00Z') });
    expect(orders).toHaveLength(ZID_PER_PAGE * 2 - 1);
    expect(orders.some((o) => o.id === 'old')).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test('keeps paging when the collection turns out to be oldest-first', async () => {
    // Page 1 predates the bound entirely. The newest-first exit would stop here
    // and import nothing, so the direction is detected before it is relied on.
    stub([
      zidRunAscending('old', ZID_PER_PAGE, '2026-01-01T00:00:00Z'),
      zidRunAscending('new', ZID_PER_PAGE, '2026-06-01T00:00:00Z'),
      [zidOrderNode({ id: 'newest', created_at: '2026-07-01 10:00:00' })],
    ]);
    const orders = await new ZidAdapter('access', 'auth').listOrders({ since: new Date('2026-03-04T00:00:00Z') });
    expect(orders).toHaveLength(ZID_PER_PAGE + 1);
    expect(orders.some((o) => o.id === 'old0')).toBe(false);
    expect(orders.at(-1)?.id).toBe('newest');
    expect(calls).toHaveLength(3);
  });
});
