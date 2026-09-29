import { catalogRepo, orderRepo, storeRepo } from '../db/repos.js';
import { markConversionsForOrder } from '../services/analytics.js';
import { logger } from './logger.js';
import type { Product, Order, Platform } from '../types.js';
import type { WebhookEvent } from './webhooks.js';
// Salla/Zid payload shapes are pinned to those the sync + order-backfill paths
// already document and unit-test, so a webhook resolves to exactly the same
// Order/Product as the API responses it mirrors. See the mappers' fixtures in
// src/integrations/{salla,zid}.spec.ts.
import { mapSallaOrder, mapSallaProduct } from '../integrations/salla.js';
import { mapZidOrder, mapZidProduct } from '../integrations/zid.js';

type RawEntity = Record<string, any>;

function mapShopifyProduct(p: RawEntity): Product | null {
  const variants = (p.variants ?? []) as RawEntity[];
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

// Platform-pinned entity mappers. `mapSallaOrder`/`mapZidOrder` accept the
// documented raw API shapes; the webhook wrapper entities are structurally the
// same records those mappers already parse.
const orderMappers: Partial<Record<Platform, (raw: RawEntity) => Order>> = {
  salla: (raw) => mapSallaOrder(raw as Parameters<typeof mapSallaOrder>[0]),
  zid: (raw) => mapZidOrder(raw as Parameters<typeof mapZidOrder>[0]),
};
const productMappers: Partial<Record<Platform, (raw: RawEntity) => Product>> = {
  salla: (raw) => mapSallaProduct(raw as Parameters<typeof mapSallaProduct>[0]),
  zid: (raw) => mapZidProduct(raw as Parameters<typeof mapZidProduct>[0]),
};

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

function mapGenericSingle<T extends RawEntity>(
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
    if (event.type === 'app/uninstalled') {
      await storeRepo.remove(storeId);
      logger.info({ storeId }, 'shopify: app/uninstalled — removed store and tenant data');
      return;
    }
    if (event.type === 'customers/data_request' || event.type === 'customers/redact' || event.type === 'shop/redact') {
      // Shopify PDPL/GDPR topics are recorded as events (audit trail) and fulfilled
      // manually through /api/pdpl/access + /api/pdpl/erase by the operator.
      logger.info({ storeId, type: event.type }, 'shopify: pdpl webhook recorded');
      return;
    }
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

  if (platform !== 'salla' && platform !== 'zid') {
    logger.warn({ platform }, 'webhook: no pinned entity mapper — dropped');
    return;
  }

  const type = event.type.toLowerCase();
  const mapOrder = orderMappers[platform];
  const mapProduct = productMappers[platform];

  if (type.includes('order')) {
    const raw = mapGenericSingle<RawEntity>(event.payload, ['order', 'order_data']);
    const mapped = raw ? mapOrder!(raw) : null;
    if (mapped?.id) {
      await orderRepo.upsert(storeId, mapped);
      await markConversionsForOrder(storeId, mapped);
    } else {
      logger.warn({ platform, type }, 'webhook: order payload resolved to no id — skipped');
    }
  }

  if (type.includes('product')) {
    const raw = mapGenericSingle<RawEntity>(event.payload, ['product', 'product_data']);
    const mapped = raw ? mapProduct!(raw) : null;
    if (mapped?.id) {
      await catalogRepo.upsertWebhook(storeId, mapped);
    } else {
      logger.warn({ platform, type }, 'webhook: product payload resolved to no id — skipped');
    }
  }
}