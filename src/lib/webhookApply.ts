import { catalogRepo, orderRepo, storeRepo } from '../db/repos.js';
import { markConversionsForOrder } from '../services/analytics.js';
import { eraseCustomer, eraseStorePii, getCustomerData } from '../services/pdpl.js';
import { stopStoreWhatsApp } from '../services/whatsappSession.js';
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
      // Best-effort teardown before the store row goes away: a live WhatsApp socket
      // would otherwise outlive the store, and its stored creds would be orphaned
      // once the row (and the cascaded baileys-session rows) are gone.
      await stopStoreWhatsApp(storeId).catch((err) =>
        logger.warn({ err, storeId }, 'shopify: whatsapp teardown on uninstall failed'),
      );
      await storeRepo.remove(storeId);
      logger.info({ storeId }, 'shopify: app/uninstalled — removed store and tenant data');
      return;
    }
    if (event.type === 'customers/data_request' || event.type === 'customers/redact' || event.type === 'shop/redact') {
      // App-level Shopify privacy webhooks (customers/data_request, customers/redact,
      // shop/redact). Fulfilled here — erase the customer, erase the store's PII, or
      // gather the export — always best-effort so a failing redact never pushes the
      // webhook into a Shopify retry loop.
      await fulfillShopifyPrivacy(storeId, event);
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

/**
 * Fulfils a Shopify app-level privacy webhook.
 *
 * Never throws: the callers are webhook dispatchers, and an exception there turns
 * Shopify's delivery into a retry loop against a request the handler already decided
 * to accept. Failures are logged with just enough detail to resolve without echoing
 * PII (booleans, never the identifiers themselves).
 */
async function fulfillShopifyPrivacy(storeId: string, event: WebhookEvent): Promise<void> {
  const payload = (event.payload ?? {}) as { customer?: Record<string, unknown> };
  const customer = payload.customer ?? {};
  const email = typeof customer.email === 'string' && customer.email ? customer.email : undefined;
  const phone = typeof customer.phone === 'string' && customer.phone ? customer.phone : undefined;

  if (event.type === 'customers/redact') {
    try {
      // matchAny (OR) on purpose: the payload carries whatever Shopify knows —
      // often only email — and a mismatch on one identifier must not fail the erase.
      const erased = await eraseCustomer(storeId, { email, phone }, true);
      logger.info({ storeId, erased, hasEmail: !!email, hasPhone: !!phone }, 'shopify: customers/redact fulfilled');
    } catch (err) {
      logger.warn({ err, storeId }, 'shopify: customers/redact fulfillment failed');
    }
    return;
  }

  if (event.type === 'shop/redact') {
    try {
      const counts = await eraseStorePii(storeId);
      logger.info({ storeId, counts }, 'shopify: shop/redact fulfilled');
    } catch (err) {
      logger.warn({ err, storeId }, 'shopify: shop/redact fulfillment failed');
    }
    return;
  }

  // customers/data_request: there is no mail-out transport in this product, so the
  // export is gathered and made available to the operator (it remains retrievable
  // through /api/pdpl/access); record what was found for the audit event.
  try {
    const data = await getCustomerData(storeId, { email, phone });
    logger.info(
      { storeId, found: !!data, orders: data?.orders?.length ?? 0, conversations: data?.conversations?.length ?? 0 },
      'shopify: customers/data_request recorded',
    );
  } catch (err) {
    logger.warn({ err, storeId }, 'shopify: customers/data_request failed');
  }
}