import type { CommerceAdapter, Product, Order } from '../types.js';
import { fetchWithTimeout } from '../lib/http.js';
import { parsePlatformDate, toPlatformDateParam } from '../lib/platformDate.js';

const DEFAULT_BASE_URL = 'https://api.salla.sa/admin/v2';

/** Ceiling on order pages per sync, so a store with a huge history cannot spin. */
const MAX_ORDER_PAGES = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

type SallaApiResponse<T> = {
  status: number;
  success: boolean;
  data: T | null;
  message?: string;
  pagination?: {
    count?: number;
    total?: number;
    perPage?: number;
    currentPage?: number;
    totalPages?: number;
    links?: { next?: string | null };
  };
};

type SallaRawProduct = {
  id: number;
  name: string;
  sku?: string;
  status?: 'sale' | 'out' | 'hidden' | 'deleted';
  quantity?: number;
  unlimited_quantity?: boolean;
  is_available?: boolean;
  price?: { amount: string | number; currency?: string };
  description?: string;
  url?: string;
};

/**
 * `ListOrders` as documented at https://docs.salla.dev/api-5394146. The placement
 * date lives under `date` (a `{date, timezone}` object) and the total under
 * `total`; an order-level `created_at` and an `amounts` wrapper appear in older
 * hand-written fixtures but not in the API, and reading them alone left every
 * imported Salla order valued at zero.
 */
type SallaRawOrder = {
  id: number;
  date?: { date?: string; timezone?: string; timezone_type?: number };
  created_at?: string;
  status?: {
    id?: number;
    name?: string;
    slug?: string;
    customized?: { id?: number; name?: string } | null;
  };
  payment_method?: string;
  payment_methods?: { payment_method?: string; amount?: string | number }[];
  total?: { amount?: string | number; currency?: string };
  customer?: {
    id?: number;
    full_name?: string;
    first_name?: string;
    last_name?: string;
    mobile?: string | number;
    email?: string;
  };
};

export function mapSallaProduct(p: SallaRawProduct): Product {
  const available =
    p.status === 'sale' && (Number(p.quantity ?? 0) > 0 || Boolean(p.unlimited_quantity));
  const price = Number(p.price?.amount ?? 0);
  const currency = p.price?.currency ?? 'SAR';
  return {
    id: String(p.id),
    title: p.name,
    description: p.description?.trim() || undefined,
    price,
    currency,
    available,
    url: p.url,
    sku: p.sku || undefined,
  };
}

export function mapSallaOrder(o: SallaRawOrder): Order {
  const placedAt =
    parsePlatformDate(o.date?.date, o.date?.timezone) ?? parsePlatformDate(o.created_at);

  // `total.amount` is a string on the wire ("16.39"); Number() of a non-numeric
  // string is NaN, and a NaN total silently poisons every revenue rollup it
  // reaches, so it is resolved to 0 instead.
  const total = Number(o.total?.amount ?? 0);

  return {
    id: String(o.id),
    status: o.status?.name ?? o.status?.slug ?? o.status?.customized?.name ?? 'unknown',
    paymentStatus: o.payment_method ?? o.payment_methods?.[0]?.payment_method,
    total: Number.isFinite(total) ? total : 0,
    currency: o.total?.currency ?? 'SAR',
    customer: {
      name:
        o.customer?.full_name ||
        [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') ||
        undefined,
      phone: o.customer?.mobile == null ? undefined : String(o.customer.mobile),
      email: o.customer?.email,
    },
    placedAt,
  };
}

export class SallaAdapter implements CommerceAdapter {
  platform = 'salla' as const;

  constructor(
    private token: string,
    private baseUrl = process.env.SALLA_API_BASE_URL ?? DEFAULT_BASE_URL,
  ) {}

  private async api<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const r = await fetchWithTimeout(url.toString(), {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!r.ok) throw new Error(`Salla ${r.status}`);
    const j = (await r.json()) as SallaApiResponse<T>;
    if (!j.success || j.data == null) throw new Error(`Salla error: ${j.message ?? j.status}`);
    return j.data;
  }

  async listProducts(): Promise<Product[]> {
    const PER_PAGE = 100;
    const MAX_PAGES = 50;
    const all: Product[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const d = await this.api<{ products: SallaRawProduct[] } | SallaRawProduct[]>(`/products`, {
        page,
        per_page: PER_PAGE,
      });
      const items = Array.isArray(d) ? (d as SallaRawProduct[]) : (d as { products: SallaRawProduct[] }).products;
      if (!items?.length) break;
      for (const p of items) all.push(mapSallaProduct(p));
      if (items.length < PER_PAGE) break;
    }
    return all;
  }

  async searchProducts(query: string): Promise<Product[]> {
    const q = query.trim().slice(0, 100);
    try {
      const d = await this.api<{ products: SallaRawProduct[] } | SallaRawProduct[]>(`/products`, {
        keyword: q,
        page: 1,
        per_page: 8,
      });
      const items = Array.isArray(d) ? (d as SallaRawProduct[]) : (d as { products: SallaRawProduct[] }).products;
      return (items ?? []).map(mapSallaProduct);
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

  async getOrder(id: string): Promise<Order | null> {
    const d = await this.api<SallaRawOrder>(`/orders/${encodeURIComponent(id)}`);
    if (!d?.id) return null;
    return mapSallaOrder(d);
  }

  /**
   * Salla's orders collection supports server-side `from_date` / `to_date`
   * filters (https://docs.salla.dev/api-5394146), and those are what bound the
   * scan here. Both are calendar dates, so `since` is widened by a day and the
   * exact timestamp boundary is re-applied client-side below.
   *
   * The collection's default sort is not documented, so paging deliberately does
   * not assume newest-first: the scan runs to the end of the filtered window and
   * stops only on a short page. Guessing the order wrong loses history silently
   * — on an oldest-first collection, "stop once past `since`" exits after page 1
   * and imports nothing.
   */
  async listOrders(opts: { since?: Date; until?: Date; limit?: number } = {}): Promise<Order[]> {
    // Salla documents `per_page=30` as the maximum page size for orders. Asking
    // for more yields a short page, which a size-agnostic loop reads as the end
    // of the collection and silently caps a backfill at 30 orders.
    const PER_PAGE = 30;
    const limit = Math.max(1, opts.limit ?? PER_PAGE * MAX_ORDER_PAGES);
    const params: Record<string, string | number> = { per_page: PER_PAGE };
    if (opts.since) params.from_date = toPlatformDateParam(new Date(opts.since.getTime() - DAY_MS));
    if (opts.until) params.to_date = toPlatformDateParam(opts.until);

    const all: Order[] = [];
    for (let page = 1; all.length < limit; page++) {
      const d = await this.api<{ orders?: SallaRawOrder[] } | SallaRawOrder[]>(`/orders`, {
        ...params,
        page,
      });
      const items = Array.isArray(d) ? (d as SallaRawOrder[]) : (d as { orders?: SallaRawOrder[] }).orders;
      if (!items?.length) break;
      for (const raw of items) {
        const o = mapSallaOrder(raw);
        if (o.placedAt && opts.since && o.placedAt < opts.since) continue;
        if (o.placedAt && opts.until && o.placedAt >= opts.until) continue;
        all.push(o);
        if (all.length >= limit) break;
      }
      if (items.length < PER_PAGE) break;
    }
    return all;
  }
}