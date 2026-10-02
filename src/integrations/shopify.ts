import { CommerceAdapter, Product, Order } from '../types.js';
import { fetchWithTimeout, LONG_TIMEOUT_MS } from '../lib/http.js';
import { logger } from '../lib/logger.js';

/**
 * Shared by getOrder and the listOrders backfill so both produce an identical
 * Order shape. `currentTotalPriceSet.shopMoney` is authoritative and already
 * carries the currency, so a separate currencyCode is not needed.
 *
 * Note the field is `currencyCode`: MoneyV2 exposes `amount` and `currencyCode`,
 * and an unknown field makes the whole query fail to validate rather than
 * returning a null.
 */
export function mapShopifyOrderNode(o: Record<string, any>): Order {
  const placedAt = o.createdAt ? new Date(o.createdAt) : undefined;
  return {
    id: String(o.id),
    status: o.displayFulfillmentStatus,
    paymentStatus: o.displayFinancialStatus,
    total: Number(o.currentTotalPriceSet?.shopMoney?.amount ?? 0),
    currency: o.currentTotalPriceSet?.shopMoney?.currencyCode ?? 'SAR',
    customer: {
      name: o.customer?.displayName,
      email: o.customer?.email,
      phone: o.customer?.phone,
    },
    placedAt: placedAt && !Number.isNaN(placedAt.getTime()) ? placedAt : undefined,
  };
}

/**
 * Detects Shopify's per-field scope error for `customer`.
 *
 * `orders.nodes.customer` is gated behind the `read_customers` access scope, and
 * a token without it does not get a null field back — the whole query comes back
 * ACCESS_DENIED. That fails every order sync for the store, and once the retries
 * are spent the job is dead with no order history imported at all.
 */
function deniesCustomerField(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /customer/i.test(msg) && /ACCESS_DENIED|read_customers/.test(msg);
}

export class ShopifyAdapter implements CommerceAdapter {
  platform = 'shopify' as const;

  /**
   * Set once this token is known to be unable to read customers, so the retry
   * costs one failed request per process rather than one per page.
   */
  private customerScopeDenied = false;

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

  private orderNodeFields(withCustomer: boolean): string {
    const customer = withCustomer ? ' customer{displayName email phone}' : '';
    return `id createdAt displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet{shopMoney{amount currencyCode}}${customer}`;
  }

/**
   * Runs an order query, dropping the `customer` selection and retrying once if
   * the token turns out not to be allowed to read it.
   *
   * The fallback keeps revenue and order counts intact and only drops phone and
   * email, which `markConversationsForOrder` uses to attribute a sale to a
   * conversation. Trading conversion attribution for the entire order history is a
   * good deal, and a merchant who re-authorises with the wider scope gets the
   * customer fields back automatically.
   *
   * The downgrade is logged at warn, not debug. Silence here is what made an
   * `order_placed` automation look broken: the token came back `ACCESS_DENIED` for
   * `read_customers`, every order synced "successfully" with a null customer, and the
   * rule then matched nothing because there was no phone to send to. Sync reporting
   * success while the only field the product needs was dropped is worth shouting about.
   */
  private async gqlOrderQuery(
    build: (withCustomer: boolean) => string,
    variables: Record<string, unknown> = {},
  ): Promise<any> {
    try {
      return await this.gql(build(!this.customerScopeDenied), variables);
    } catch (err) {
      if (this.customerScopeDenied || !deniesCustomerField(err)) throw err;
      this.customerScopeDenied = true;
      logger.warn(
        {
          shop: this.shop,
          err: err instanceof Error ? err.message : String(err),
        },
        'shopify: token cannot read customer fields; orders will sync WITHOUT customer phone and email. Re-authorise the app with the read_customers scope to restore them. Any automation that messages a customer (e.g. order_placed) will match no candidates until then.',
      );
return await this.gql(build(false), variables);
    }
  }

  /**
   * `{ shop { name } }` rather than a products query: it is a single round trip,
   * it needs no scope beyond the app being installed, and it distinguishes the two
   * failure modes that matter here — a bad token comes back as a GraphQL error
   * from Shopify, while a wrong `shop` domain comes back as a transport/401,
   * which is exactly the pair a merchant pasting credentials by hand gets wrong.
   */
  async verify(): Promise<void> {
    await this.gql(`query{shop{name}}`);
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

  /**
   * Backfill window. Shopify's search syntax takes an inclusive `created_at:>=`
   * bound and is passed as the `query:` argument (not `search:`), which is why
   * this is a GraphQL variable rather than string-interpolated. `until` is
   * filtered client-side because the search operator has no open upper bound we
   * can rely on, and a half-open window is what the resume cursor assumes.
   */
  async listOrders(opts: { since?: Date; until?: Date; limit?: number } = {}): Promise<Order[]> {
    const PAGE_SIZE = 100;
    const MAX_PAGES = 50;
    const limit = Math.max(1, Math.min(opts.limit ?? PAGE_SIZE * MAX_PAGES, PAGE_SIZE * MAX_PAGES));
    const search = opts.since ? `created_at:>=${opts.since.toISOString()}` : null;
    const all: Order[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES && all.length < limit; page++) {
      const d = await this.gqlOrderQuery(
        (withCustomer) =>
          `query($first:Int!,$after:String,$query:String){orders(first:$first,after:$after,sortKey:CREATED_AT,query:$query){pageInfo{hasNextPage endCursor}nodes{${this.orderNodeFields(withCustomer)}}}}`,
        {
          first: Math.min(PAGE_SIZE, limit - all.length),
          after: cursor,
          query: search,
        },
      );
      for (const o of d.orders.nodes as any[]) {
        const placedAt = o.createdAt ? new Date(o.createdAt) : undefined;
        if (placedAt && !Number.isNaN(placedAt.getTime()) && opts.until && placedAt >= opts.until) continue;
        all.push(mapShopifyOrderNode(o));
      }
      if (!d.orders.pageInfo.hasNextPage) break;
      cursor = d.orders.pageInfo.endCursor;
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
    const d = await this.gqlOrderQuery(
      (withCustomer) => `query($id:ID!){order(id:$id){${this.orderNodeFields(withCustomer)}}}`,
      { id },
    );
    const o = d.order;
    if (!o) return null;
    return mapShopifyOrderNode(o);
  }
}