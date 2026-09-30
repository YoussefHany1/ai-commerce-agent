import type { CommerceAdapter, Product, Order } from '../types.js';
import { fetchWithTimeout } from '../lib/http.js';
import { parsePlatformDate } from '../lib/platformDate.js';

const DEFAULT_BASE_URL = 'https://api.zid.sa/v1';

/** Ceiling on order pages per sync, so a store with a huge history cannot spin. */
const MAX_ORDER_PAGES = 100;

type ZidApiResponse<T> = {
  success?: boolean;
  data?: T;
  message?: string;
};

type ZidPaginated<T> = {
  count?: number;
  next?: string | null;
  previous?: string | null;
  results?: T[];
  data?: T[] | T;
};

/**
 * Zid's manager order collection (https://docs.zid.sa/list-of-orders) answers
 * `{"status": "object", "orders": [...]}` — the orders sit at the top level,
 * neither wrapped in `data` nor under the `results` key the product collection
 * uses. All three shapes are accepted so the other endpoints keep working.
 */
type ZidOrderList = {
  /** Single-order view envelope: `{status, order, message}`. */
  order?: ZidRawOrder;
  orders?: ZidRawOrder[];
  results?: ZidRawOrder[];
  data?: ZidRawOrder[] | { order?: ZidRawOrder; orders?: ZidRawOrder[]; results?: ZidRawOrder[] };
};

type ZidRawProduct = {
  id: string | number;
  name?: string | { ar?: string; en?: string } | null;
  sku?: string | null;
  price: string | number;
  currency?: string | null;
  is_published?: boolean;
  is_draft?: boolean;
  is_deleted?: boolean;
  quantity?: string | number;
  is_infinite?: boolean;
  is_out_of_stock?: boolean;
  html_url?: string | null;
  short_description?: string | { ar?: string; en?: string } | null;
};

/**
 * `List Orders` as documented at https://docs.zid.sa/list-of-orders. Timestamps
 * (`created_at`, `updated_at`) arrive as `"2025-11-12 08:57:35"` with no zone,
 * `order_total` is a numeric string, and `payment_status` is a bare string.
 */
type ZidRawOrder = {
  id: string | number;
  created_at?: string;
  created_date?: string;
  code?: string | number;
  invoice_number?: string | number;
  order_status?: { code?: string | number; name?: string } | string;
  display_status?: { code?: string; name?: string };
  payment_status?: { code?: string; name?: string } | string;
  order_total?: string | number;
  order_total_string?: string;
  currency_code?: string;
  customer?: { name?: string; email?: string; mobile?: string };
};

function pickName(v: string | { ar?: string; en?: string } | null | undefined): string | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return v || undefined;
  return v.en || v.ar || undefined;
}

export function mapZidProduct(p: ZidRawProduct): Product {
  const quantity = Number(p.quantity ?? 0);
  const unavailable =
    p.is_draft === true ||
    p.is_published === false ||
    p.is_deleted === true ||
    p.is_out_of_stock === true;
  const available = !unavailable && (p.is_infinite === true || quantity > 0);
  return {
    id: String(p.id),
    title: pickName(p.name) ?? 'بدون اسم',
    description: pickName(p.short_description),
    price: Number(p.price ?? 0),
    currency: p.currency ?? 'SAR',
    available,
    url: p.html_url ?? undefined,
    sku: p.sku ?? undefined,
  };
}

export function mapZidOrder(o: ZidRawOrder): Order {
  let status: string;
  if (typeof o.display_status?.name === 'string') status = o.display_status.name;
  else if (typeof o.order_status === 'string') status = o.order_status;
  else if (o.order_status?.name) status = o.order_status.name;
  else if (o.order_status?.code != null) status = String(o.order_status.code);
  else status = 'unknown';

  let paymentStatus: string | undefined;
  if (typeof o.payment_status === 'string') paymentStatus = o.payment_status;
  else if (o.payment_status?.name) paymentStatus = o.payment_status.name;
  else if (o.payment_status?.code != null) paymentStatus = String(o.payment_status.code);

  // `created_at` is offset-free, so it is read as Riyadh local time; passing it
  // straight to `new Date()` resolves it against the host timezone instead.
  const placedAt = parsePlatformDate(o.created_at) ?? parsePlatformDate(o.created_date);

  return {
    id: String(o.id ?? o.invoice_number ?? o.code ?? ''),
    status,
    paymentStatus,
    total: zidOrderTotal(o),
    currency: o.currency_code ?? 'SAR',
    customer: {
      name: o.customer?.name,
      phone: o.customer?.mobile,
      email: o.customer?.email,
    },
    placedAt,
  };
}

/**
 * Zid sends `order_total` as a high-precision decimal string
 * ("6954.63998402370000"). `order_total_string` is deliberately *not* used as a
 * fallback: on the view endpoint it is a localized display value
 * ("6,954.64 ج.م"), and `parseFloat` on that stops at the thousands separator
 * and reports 6. A missing total resolves to 0, which shows up as a visible gap
 * in the rollup rather than a plausible-looking wrong figure.
 */
function zidOrderTotal(o: ZidRawOrder): number {
  const raw = typeof o.order_total === 'string' ? o.order_total.trim() : o.order_total;
  if (raw == null || raw === '') return 0;
  const direct = Number(raw);
  return Number.isFinite(direct) ? direct : 0;
}

export class ZidAdapter implements CommerceAdapter {
  platform = 'zid' as const;

  constructor(
    private accessToken: string,
    private authorization: string,
    private baseUrl = process.env.ZID_API_BASE_URL ?? DEFAULT_BASE_URL,
  ) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Language': 'ar',
      Role: 'Manager',
      Authorization: `Bearer ${this.authorization}`,
      'X-Manager-Token': this.accessToken,
    };
  }

  private async api<T>(path: string, params: Record<string, string | number | boolean> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const r = await fetchWithTimeout(url.toString(), { headers: this.headers() });
    if (!r.ok) throw new Error(`Zid ${r.status}`);
    const j = (await r.json()) as T | ZidApiResponse<T>;
    const body = j as ZidApiResponse<T>;
    if (body.success === false) throw new Error(`Zid error: ${body.message ?? 'request_failed'}`);
    return (body.success === true && body.data !== undefined ? body.data : j) as T;
  }

  /** One product, one page: enough to prove the credentials authenticate, cheap enough to sit in a request path. */
  async verify(): Promise<void> {
    await this.api<unknown>('/products/', { page: 1, page_size: 1 });
  }

  async listProducts(): Promise<Product[]> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 50;
    const all: Product[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const d = await this.api<ZidPaginated<ZidRawProduct>>(`/products/`, {
        page,
        page_size: PAGE_SIZE,
        extended: true,
        include_deleted: false,
      });
      const items = Array.isArray(d) ? d : (d.results ?? (Array.isArray(d.data) ? (d.data as ZidRawProduct[]) : null)) ?? [];
      if (!items.length) break;
      for (const p of items) all.push(mapZidProduct(p));
      if (d.count != null && all.length >= d.count) break;
      if (items.length < PAGE_SIZE) break;
    }
    return all;
  }

  async searchProducts(query: string): Promise<Product[]> {
    const q = query.trim().slice(0, 100);
    try {
      const d = await this.api<ZidPaginated<ZidRawProduct>>(`/products/`, {
        search: q,
        page: 1,
        page_size: 8,
        extended: true,
        include_deleted: false,
      });
      const items = Array.isArray(d) ? d : (d.results ?? (Array.isArray(d.data) ? (d.data as ZidRawProduct[]) : null)) ?? [];
      return items.map(mapZidProduct);
    } catch {
      return (await this.listProducts())
        .filter(
          (p) =>
            p.title.toLowerCase().includes(q.toLowerCase()) ||
            (p.description ?? '').toLowerCase().includes(q.toLowerCase()),
        )
        .slice(0, 8);
    }
  }

  /**
   * Single-order view. The route is `/{order-id}/view`, not `/{id}`, and the
   * order arrives under the singular `order` key of a `{status, order, message}`
   * envelope with no `success`/`data` wrapper.
   * See https://docs.zid.sa/view-order-12479054e0.
   */
  async getOrder(id: string): Promise<Order | null> {
    const d = await this.api<ZidOrderList>(`/managers/store/orders/${encodeURIComponent(id)}/view`);
    const raw = extractZidOrders(d)[0];
    if (!raw?.id && !raw?.invoice_number) return null;
    return mapZidOrder(raw);
  }

  /**
   * Zid's order collection takes `per_page` (not the `page_size` its account
   * endpoints use) and returns orders in a top-level `orders` array.
   *
   * The collection's default sort is undocumented, so rather than assume
   * newest-first the first full page is inspected to learn the direction, and
   * only a descending run is exited early once it walks past `since`. Assuming
   * newest-first on an oldest-first collection would exit after page 1 and
   * import nothing, while refusing to stop early makes an incremental sync
   * re-read the store's entire order history every 15 minutes.
   */
  async listOrders(opts: { since?: Date; until?: Date; limit?: number } = {}): Promise<Order[]> {
    const PER_PAGE = 100;
    const limit = Math.max(1, opts.limit ?? PER_PAGE * MAX_ORDER_PAGES);
    const all: Order[] = [];
    let newestFirst: boolean | undefined;

    for (let page = 1; page <= MAX_ORDER_PAGES && all.length < limit; page++) {
      const d = await this.api<ZidOrderList | ZidRawOrder[]>(`/managers/store/orders`, {
        page,
        per_page: PER_PAGE,
        payload_type: 'simple',
      });
      const items = extractZidOrders(d);
      if (!items.length) break;
      newestFirst ??= detectNewestFirst(items.map((raw) => parsePlatformDate(raw.created_at)));
      let pastWindow = false;
      for (const raw of items) {
        const o = mapZidOrder(raw);
        if (o.placedAt && opts.since && o.placedAt < opts.since) {
          pastWindow = true;
          continue;
        }
        if (o.placedAt && opts.until && o.placedAt >= opts.until) continue;
        all.push(o);
        if (all.length >= limit) break;
      }
      if (newestFirst && pastWindow) break;
      if (items.length < PER_PAGE) break;
    }
    return all;
  }
}

/** Pulls the order array out of any of Zid's response envelopes. */
function extractZidOrders(d: ZidOrderList | ZidRawOrder[]): ZidRawOrder[] {
  if (Array.isArray(d)) return d;
  if (Array.isArray(d.orders)) return d.orders;
  if (d.order) return [d.order];
  if (Array.isArray(d.results)) return d.results;
  if (Array.isArray(d.data)) return d.data;
  if (d.data && !Array.isArray(d.data)) {
    const nested = d.data;
    if (nested.order) return [nested.order];
    return nested.orders ?? nested.results ?? [];
  }
  return [];
}

/**
 * Reads the sort direction off a page: a non-increasing run of dates is
 * newest-first. Returns `undefined` while the direction is still unknown, which
 * keeps paging until a page arrives that has enough dated rows to tell.
 */
function detectNewestFirst(dates: (Date | undefined)[]): boolean | undefined {
  const dated = dates.filter((d): d is Date => d != null);
  if (dated.length < 2) return undefined;
  for (let i = 1; i < dated.length; i++) {
    if (dated[i]!.getTime() > dated[i - 1]!.getTime()) return false;
  }
  return true;
}