import { afterEach, describe, expect, it, vi } from 'vitest';

const repos = vi.hoisted(() => ({
  storeRepo: { get: vi.fn(), getSecret: vi.fn(async () => null) },
  connectionRepo: { get: vi.fn(), refreshIfExpired: vi.fn(), decryptToken: vi.fn(() => 'tok') },
}));

vi.mock('../db/repos.js', () => ({
  storeRepo: repos.storeRepo,
  connectionRepo: repos.connectionRepo,
}));

import { getCommerceAdapter } from './factory.js';
import { invalidateCommerceAdapter } from './adapterCache.js';

function primeShopify(storeId: string): void {
  repos.storeRepo.get.mockImplementation(async (id: string) =>
    id === storeId ? { platform: 'shopify', shopDomain: 'x.myshopify.com' } : null,
  );
  repos.connectionRepo.get.mockResolvedValue({ accessTokenEnc: 'enc' });
  repos.connectionRepo.refreshIfExpired.mockResolvedValue(true);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('getCommerceAdapter caching', () => {
  it('builds once and reuses the adapter for the same store', async () => {
    const storeId = 's-cache-reuse';
    primeShopify(storeId);

    const first = await getCommerceAdapter(storeId);
    const second = await getCommerceAdapter(storeId);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(repos.storeRepo.get).toHaveBeenCalledTimes(1);
  });

  it('rebuilds after the entry is invalidated', async () => {
    const storeId = 's-cache-invalidate';
    primeShopify(storeId);

    await getCommerceAdapter(storeId);
    invalidateCommerceAdapter(storeId);
    await getCommerceAdapter(storeId);

    expect(repos.storeRepo.get).toHaveBeenCalledTimes(2);
  });

  it('does not cache a missing store', async () => {
    const storeId = 's-cache-missing';
    repos.storeRepo.get.mockResolvedValue(null);

    expect(await getCommerceAdapter(storeId)).toBeNull();
    expect(await getCommerceAdapter(storeId)).toBeNull();
    expect(repos.storeRepo.get).toHaveBeenCalledTimes(2);
  });
});
