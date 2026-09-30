import { describe, expect, test, vi, beforeEach } from 'vitest';
import { saveInstall, InstallConflictError } from './oauth.js';

const mocks = vi.hoisted(() => ({
  storeRepo: {
    // Typed as returning a row or null, not just null: `saveInstall` reads
    // `existing.clientId`, and a mock inferred as `() => null` makes every
    // `mockResolvedValue(row)` in the ownership cases a type error.
    byRef: vi.fn(
      async (): Promise<{ id: string; clientId: string | null } | null> => null,
    ),
    create: vi.fn(async () => 'store-new'),
    updateSettings: vi.fn(async () => {}),
  },
  connectionRepo: { setTokens: vi.fn(async () => {}) },
  jobsRepo: { enqueue: vi.fn(async () => {}) },
}));

vi.mock('../db/repos.js', () => ({
  storeRepo: mocks.storeRepo,
  connectionRepo: mocks.connectionRepo,
  jobsRepo: mocks.jobsRepo,
}));
vi.mock('../lib/redis.js', () => ({ getRedis: vi.fn() }));
vi.mock('../lib/logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const base = {
  platform: 'shopify' as const,
  name: 'Demo',
  shopDomain: 'demo.myshopify.com',
  accessToken: 'shpat_x',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storeRepo.byRef.mockResolvedValue(null);
  mocks.storeRepo.create.mockResolvedValue('store-new');
});

describe('saveInstall: tenant ownership', () => {
  test('creates the store for the client that started the install', async () => {
    const id = await saveInstall({ ...base, clientId: 'client-a' });
    expect(id).toBe('store-new');
    expect(mocks.storeRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client-a', shopDomain: 'demo.myshopify.com' }),
    );
  });

  test('leaves clientId undefined for an unauthenticated operator install', async () => {
    await saveInstall({ ...base });
    expect(mocks.storeRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: undefined }),
    );
  });

  test('refuses to take over a store already owned by another client', async () => {
    mocks.storeRepo.byRef.mockResolvedValue({ id: 'store-other', clientId: 'client-b' });
    await expect(saveInstall({ ...base, clientId: 'client-a' })).rejects.toBeInstanceOf(
      InstallConflictError,
    );
    // The hijack path would have been setTokens on the victim's store.
    expect(mocks.connectionRepo.setTokens).not.toHaveBeenCalled();
    expect(mocks.storeRepo.create).not.toHaveBeenCalled();
  });

  test('refuses to claim an operator-owned store (clientId null)', async () => {
    mocks.storeRepo.byRef.mockResolvedValue({ id: 'store-op', clientId: null });
    await expect(saveInstall({ ...base, clientId: 'client-a' })).rejects.toBeInstanceOf(
      InstallConflictError,
    );
    expect(mocks.connectionRepo.setTokens).not.toHaveBeenCalled();
  });

  test('re-install by the same client refreshes tokens instead of erroring', async () => {
    mocks.storeRepo.byRef.mockResolvedValue({ id: 'store-mine', clientId: 'client-a' });
    const id = await saveInstall({ ...base, clientId: 'client-a' });
    expect(id).toBe('store-mine');
    expect(mocks.connectionRepo.setTokens).toHaveBeenCalledWith(
      'store-mine',
      expect.objectContaining({ accessToken: 'shpat_x' }),
    );
    expect(mocks.storeRepo.create).not.toHaveBeenCalled();
  });

  test('an operator may still re-install any shop, preserving the old behaviour', async () => {
    mocks.storeRepo.byRef.mockResolvedValue({ id: 'store-op', clientId: null });
    const id = await saveInstall({ ...base });
    expect(id).toBe('store-op');
    expect(mocks.connectionRepo.setTokens).toHaveBeenCalled();
  });
});
