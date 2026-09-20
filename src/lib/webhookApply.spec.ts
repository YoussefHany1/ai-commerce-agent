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