import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => {
  const catalogRepo = { upsertWebhook: vi.fn(), upsert: vi.fn() };
  const orderRepo = { upsert: vi.fn() };
  const storeRepo = { remove: vi.fn() };
  const analytics = { markConversionsForOrder: vi.fn() };
  return { catalogRepo, orderRepo, storeRepo, analytics };
});

vi.mock('../db/repos.js', () => ({
  catalogRepo: mocks.catalogRepo,
  orderRepo: mocks.orderRepo,
  storeRepo: mocks.storeRepo,
}));
vi.mock('../services/analytics.js', () => ({ markConversionsForOrder: mocks.analytics.markConversionsForOrder }));

import { applyWebhook } from './webhookApply.js';
import type { WebhookEvent } from './webhooks.js';
import type { Platform } from '../types.js';

function shopifyEvent(type: string, payload: Record<string, unknown>): WebhookEvent {
  return { type, payload };
}

describe('webhookApply: shopify lifecycle topics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('removes the store on app/uninstalled', async () => {
    mocks.storeRepo.remove.mockResolvedValue(undefined);
    await applyWebhook('shopify', shopifyEvent('app/uninstalled', { id: 1 }), 's1');
    expect(mocks.storeRepo.remove).toHaveBeenCalledWith('s1');
  });

  it('records pdpl topics without removing the store or touching catalog', async () => {
    await applyWebhook('shopify', shopifyEvent('customers/data_request', { id: 1 }), 's1');
    await applyWebhook('shopify', shopifyEvent('customers/redact', { id: 1 }), 's1');
    await applyWebhook('shopify', shopifyEvent('shop/redact', { id: 1 }), 's1');
    expect(mocks.storeRepo.remove).not.toHaveBeenCalled();
    expect(mocks.catalogRepo.upsertWebhook).not.toHaveBeenCalled();
    expect(mocks.orderRepo.upsert).not.toHaveBeenCalled();
  });

  it('upserts products on products/create and orders on orders/create', async () => {
    await applyWebhook('shopify', shopifyEvent('products/create', { id: 'gid://shopify/Product/1', title: 'Tee' }), 's1');
    expect(mocks.catalogRepo.upsertWebhook).toHaveBeenCalledTimes(1);
    await applyWebhook('shopify', shopifyEvent('orders/create', { id: 'gid://shopify/Order/2', total_price: '50' }), 's1');
    expect(mocks.orderRepo.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.analytics.markConversionsForOrder).toHaveBeenCalledTimes(1);
  });
});

describe('webhookApply: salla + zid pinned shapes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps a salla order webhook through mapSallaOrder shape', async () => {
    const payload = {
      event: 'order.status_updated',
      order: {
        id: 9001,
        date: { date: '2026-09-20 12:00:00', timezone: 'Asia/Riyadh' },
        status: { id: 3, name: 'تم', slug: 'completed' },
        payment_method: 'mada',
        total: { amount: '99.50', currency: 'SAR' },
        customer: { id: 7, full_name: 'محمد العتيبي', mobile: '966500000000', email: 'm@example.com' },
      },
    };
    await applyWebhook('salla', { type: 'order.status_updated', payload }, 's1');
    expect(mocks.orderRepo.upsert).toHaveBeenCalledTimes(1);
    const order = mocks.orderRepo.upsert.mock.calls[0][1];
    expect(order).toMatchObject({
      id: '9001',
      status: 'تم',
      paymentStatus: 'mada',
      total: 99.5,
      currency: 'SAR',
    });
    expect(order.customer).toMatchObject({ name: 'محمد العتيبي', phone: '966500000000', email: 'm@example.com' });
    expect(mocks.analytics.markConversionsForOrder).toHaveBeenCalledWith('s1', order);
  });

  it('maps a zid order webhook through mapZidOrder shape', async () => {
    const payload = {
      event: 'order.updated',
      order: {
        id: 5501,
        code: 'ORD-1',
        display_status: { code: 'processing', name: 'قيد التجهيز' },
        order_status: { code: 2, name: 'قيد التجهيز' },
        payment_status: 'paid',
        order_total: '6954.63998402370000',
        order_total_string: '6,954.64 ج.م',
        currency_code: 'SAR',
        created_at: '2026-09-20 08:57:35',
        customer: { name: 'سارة', mobile: '966500000001', email: 'ss@example.com' },
      },
    };
    await applyWebhook('zid', { type: 'order.updated', payload }, 's2');
    expect(mocks.orderRepo.upsert).toHaveBeenCalledTimes(1);
    const order = mocks.orderRepo.upsert.mock.calls[0][1];
    expect(order).toMatchObject({
      id: '5501',
      status: 'قيد التجهيز',
      paymentStatus: 'paid',
      total: 6954.6399840237,
      currency: 'SAR',
    });
    expect(order.customer).toMatchObject({ name: 'سارة', phone: '966500000001', email: 'ss@example.com' });
  });

  it('maps a salla product webhook through mapSallaProduct shape', async () => {
    const payload = {
      event: 'product.updated',
      product: {
        id: 77,
        name: 'قميص قطن',
        sku: 'TEE-COTTON',
        status: 'sale',
        quantity: 12,
        price: { amount: 49, currency: 'SAR' },
        description: 'قميص قطن مريح',
        url: 'https://store.salla.sa/tee-cotton',
      },
    };
    await applyWebhook('salla', { type: 'product.updated', payload }, 's1');
    expect(mocks.catalogRepo.upsertWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.catalogRepo.upsertWebhook.mock.calls[0][1]).toMatchObject({
      id: '77',
      title: 'قميص قطن',
      sku: 'TEE-COTTON',
      price: 49,
      currency: 'SAR',
      available: true,
      url: 'https://store.salla.sa/tee-cotton',
    });
  });

  it('maps a zid product webhook through mapZidProduct shape', async () => {
    const payload = {
      event: 'product.updated',
      product: {
        id: 301,
        name: { ar: 'تيشيرت', en: 'T-Shirt' },
        sku: 'TS-1',
        price: '39.90',
        currency: 'SAR',
        is_published: true,
        is_infinite: true,
        html_url: 'https://store.zid.sa/ts',
        short_description: 'تيشيرت أسود',
      },
    };
    await applyWebhook('zid', { type: 'product.updated', payload }, 's2');
    expect(mocks.catalogRepo.upsertWebhook).toHaveBeenCalledTimes(1);
    expect(mocks.catalogRepo.upsertWebhook.mock.calls[0][1]).toMatchObject({
      id: '301',
      title: 'T-Shirt',
      sku: 'TS-1',
      price: 39.9,
      currency: 'SAR',
      available: true,
      url: 'https://store.zid.sa/ts',
    });
  });

  it('drops a payload that does not match the pinned order/product shape', async () => {
    const payload = { event: 'order.updated', order_data: { some_unknown: 'shape' } };
    await applyWebhook('zid', { type: 'order.updated', payload }, 's2');
    expect(mocks.orderRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.catalogRepo.upsertWebhook).not.toHaveBeenCalled();
  });

  it('never falls back to a synthetic order/product id', async () => {
    const payload = { type: 'order.procesing', unrelated: { id: 1 } };
    await applyWebhook('salla', { type: 'order.procesing', payload }, 's1');
    expect(mocks.orderRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.catalogRepo.upsertWebhook).not.toHaveBeenCalled();
  });

  it('drops events for a platform without a pinned mapper', async () => {
    const unknown = 'meta' as Platform;
    await applyWebhook(unknown, { type: 'order.updated', payload: {} }, 's1');
    expect(mocks.orderRepo.upsert).not.toHaveBeenCalled();
    expect(mocks.catalogRepo.upsertWebhook).not.toHaveBeenCalled();
  });
});