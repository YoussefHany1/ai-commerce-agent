import { catalogRepo, orderRepo } from '../db/repos.js';
import { markConversionsForOrder } from '../services/analytics.js';
import type { Product, Order, Platform } from '../types.js';
import type { WebhookEvent } from '../lib/webhooks.js';

function mapShopifyProduct(p: Record<string, any>): Product | null {
  const variants = (p.variants ?? []) as Record<string, any>[];
  const v = variants.find((x) => x != null) ?? {};
  if (!p.id) return null;
  return {
    id: String(p.id),
    title: p.title ?? '',
    description: typeof p.body_html === 'string' ? p.body_html.replace(/<[^>]+>/g, ' ').trim() : undefined,
    price: Number(v.price ?? 0),
    currency: 'SAR',
    available: Number(v.inventory_quantity ?? 0) > 0,
    url: p.handle ? `/${p.handle}` : undefined,
    sku: v.sku ?? undefined,
  };
}

function mapShopifyOrder(o: Record<string, any>): Order | null {
  if (!o.id) return null;
  return {
    id: String(o.id),
    status: o.fulfillment_status ?? null,
    paymentStatus: o.financial_status ?? null,
    total: Number(o.current_total_price ?? o.total_price ?? 0),
    currency: o.currency ?? 'SAR',
    customer: {
      name: [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(' ') || undefined,
      phone: o.customer?.phone ?? undefined,
      email: o.customer?.email ?? undefined,
    },
  };
}

function mapGenericSingle<T extends Record<string, any>>(
  payload: Record<string, unknown>,
  getters: string[],
): T | null {
  for (const g of getters) {
    const v = payload[g];
    if (v && typeof v === 'object') return v as T;
  }
  return null;
}

export async function applyWebhook(
  platform: Platform,
  event: WebhookEvent,
  storeId: string,
): Promise<void> {
  if (platform === 'shopify') {
    if ((event.type === 'products/create' || event.type === 'products/update') && event.payload) {
      const p = mapShopifyProduct(event.payload);
      if (p) await catalogRepo.upsertWebhook(storeId, p);
    }
    if ((event.type === 'orders/create' || event.type === 'orders/update') && event.payload) {
      const o = mapShopifyOrder(event.payload);
      if (o) {
        await orderRepo.upsert(storeId, o);
        await markConversionsForOrder(storeId, o);
      }
    }
    return;
  }

  const type = event.type.toLowerCase();
  const order = mapGenericSingle<Record<string, any>>(event.payload, ['order', 'order_data']);
  if (type.includes('order') && order) {
    const mapped: Order = {
      id: String(order.id ?? event.payload.order_id ?? 'order-missing-id'),
      status: order.status ?? null,
      paymentStatus: order.payment_status ?? null,
      total: Number(order.total ?? order.amount ?? 0),
      currency: order.currency ?? 'SAR',
      customer: order.customer
        ? { name: order.customer.name, phone: order.customer.phone, email: order.customer.email }
        : undefined,
    };
    await orderRepo.upsert(storeId, mapped);
    await markConversionsForOrder(storeId, mapped);
  }
  const product = mapGenericSingle<Record<string, any>>(event.payload, ['product', 'product_data']);
  if (type.includes('product') && product) {
    await catalogRepo.upsertWebhook(storeId, {
      id: String(product.id ?? event.payload.product_id ?? 'product-missing-id'),
      title: product.title ?? '',
      description: product.description ?? undefined,
      price: Number(product.price ?? 0),
      currency: product.currency ?? 'SAR',
      available: product.available ?? true,
      url: undefined,
      sku: product.sku ?? undefined,
    });
  }
}