import { CommerceAdapter, Product, Order } from '../types.js';
import { fetchWithTimeout, LONG_TIMEOUT_MS } from '../lib/http.js';

export class ShopifyAdapter implements CommerceAdapter {
  platform = 'shopify' as const;

  constructor(
    private shop: string,
    private token: string,
    private version = process.env.SHOPIFY_API_VERSION ?? '2026-07',
  ) {}

  private async gql(query: string, variables = {}) {
    const r = await fetchWithTimeout(
      `https://${this.shop}/admin/api/${this.version}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': this.token,
        },
        body: JSON.stringify({ query, variables }),
      },
      LONG_TIMEOUT_MS,
    );
    if (!r.ok) throw new Error(`Shopify ${r.status}`);
    const j = (await r.json()) as any;
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  }

  async listProducts(): Promise<Product[]> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 50;
    const all: Product[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const afterArg = cursor ? `after: "${cursor}"` : '';
      const d = await this.gql(
        `query($first:Int!){products(first:$first,sortKey:TITLE,${afterArg}){pageInfo{hasNextPage endCursor}nodes{id title descriptionHtml handle status variants(first:10){nodes{id price inventoryQuantity sku}}}}}`,
        { first: PAGE_SIZE },
      );
      for (const p of d.products.nodes as any[]) {
        for (const v of p.variants.nodes) {
          all.push({
            id: v.id,
            title: p.title,
            description: p.descriptionHtml?.replace(/<[^>]+>/g, ' ').trim(),
            price: Number(v.price),
            currency: 'SAR',
            available: (v.inventoryQuantity ?? 0) > 0,
            url: `https://${this.shop}/products/${p.handle}`,
            sku: v.sku || undefined,
          });
        }
      }
      if (!d.products.pageInfo.hasNextPage) break;
      cursor = d.products.pageInfo.endCursor;
    }
    return all;
  }

  async searchProducts(q: string): Promise<Product[]> {
    return (await this.listProducts())
      .filter(
        (p) =>
          p.title.toLowerCase().includes(q.toLowerCase()) ||
          (p.description ?? '').toLowerCase().includes(q.toLowerCase()),
      )
      .slice(0, 8);
  }

  async getOrder(id: string): Promise<Order | null> {
    const d = await this.gql(
      `query($id:ID!){order(id:$id){id displayFinancialStatus currentTotalPriceSet{shopMoney{amount currency}} customer{displayName email phone} displayFulfillmentStatus}}`,
      { id },
    );
    const o = d.order;
    if (!o) return null;
    return {
      id: o.id,
      status: o.displayFulfillmentStatus,
      paymentStatus: o.displayFinancialStatus,
      total: Number(o.currentTotalPriceSet.shopMoney.amount),
      currency: o.currentTotalPriceSet.shopMoney.currency,
      customer: {
        name: o.customer?.displayName,
        email: o.customer?.email,
        phone: o.customer?.phone,
      },
    };
  }
}