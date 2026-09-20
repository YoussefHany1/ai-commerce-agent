import type { CommerceAdapter, Product, Order } from '../types.js';

const DEFAULT_BASE_URL = 'https://api.zid.sa/v1';

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

type ZidRawOrder = {
  id: string | number;
  code?: string | number;
  invoice_number?: string | number;
  order_status?: { code?: string | number; name?: string } | string;
  display_status?: { code?: string; name?: string };
  payment_status?: { code?: string; name?: string } | string;
  order_total?: string | number;
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

  return {
    id: String(o.id ?? o.invoice_number ?? o.code ?? ''),
    status,
    paymentStatus,
    total: Number(o.order_total ?? 0),
    currency: o.currency_code ?? 'SAR',
    customer: {
      name: o.customer?.name,
      phone: o.customer?.mobile,
      email: o.customer?.email,
    },
  };
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
    const r = await fetch(url.toString(), { headers: this.headers() });
    if (!r.ok) throw new Error(`Zid ${r.status}`);
    const j = (await r.json()) as T | ZidApiResponse<T>;
    const body = j as ZidApiResponse<T>;
    if (body.success === false) throw new Error(`Zid error: ${body.message ?? 'request_failed'}`);
    return (body.success === true && body.data !== undefined ? body.data : j) as T;
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

  async getOrder(id: string): Promise<Order | null> {
    const d = await this.api<{ data?: ZidRawOrder[] } | ZidRawOrder[]>(
      `/managers/store/orders/${encodeURIComponent(id)}/`,
    );
    const items = Array.isArray(d) ? (d as ZidRawOrder[]) : (d as { data?: ZidRawOrder[] }).data;
    const raw = Array.isArray(items) ? items[0] : items;
    if (!raw?.id && !raw?.invoice_number) return null;
    return mapZidOrder(raw);
  }
}