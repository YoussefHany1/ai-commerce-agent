import type { CommerceAdapter, Product, Order } from '../types.js';

const DEFAULT_BASE_URL = 'https://api.salla.sa/admin/v2';

type SallaApiResponse<T> = {
  status: number;
  success: boolean;
  data: T | null;
  message?: string;
  pagination?: {
    currentPage: number;
    totalPages: number;
    totalItems: number;
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

type SallaRawOrder = {
  id: number;
  status?: { name?: string; slug?: string };
  payment_method?: { id?: number; name?: string };
  currency?: string;
  amounts?: {
    total?: { amount: string | number; currency?: string };
  };
  customer?: {
    first_name?: string;
    last_name?: string;
    mobile?: string;
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
  return {
    id: String(o.id),
    status: o.status?.name ?? o.status?.slug ?? 'unknown',
    paymentStatus: o.payment_method?.name,
    total: Number(o.amounts?.total?.amount ?? 0),
    currency: o.amounts?.total?.currency ?? o.currency ?? 'SAR',
    customer: {
      name: [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || undefined,
      phone: o.customer?.mobile,
      email: o.customer?.email,
    },
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
    const r = await fetch(url.toString(), {
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
}