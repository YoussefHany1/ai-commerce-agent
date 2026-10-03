import type { CommerceAdapter } from '../types.js';

/**
 * Short-lived in-process cache for built commerce adapters.
 *
 * `getCommerceAdapter` costs several round-trips (store row, connection row,
 * refresh check, second connection read, token decrypt, and a settings read for
 * Zid) plus a possible token refresh. The chat agent rebuilds one for every
 * `get_order_status` call, so the same store pays that cost repeatedly within a
 * single conversation. This memoizes the built adapter by store.
 *
 * Safety rests on the TTL being shorter than the refresh margin in
 * `connectionRepo.refreshIfExpired` (60s): an adapter is only cached after that
 * check proved the token valid for at least another 60s, so a 30s entry can never
 * hand out an expired token. Credential changes that could invalidate the old
 * token outright — reinstall/OAuth `setTokens`, store deletion — evict eagerly.
 */
const ADAPTER_TTL_MS = 30_000;

type Entry = { adapter: CommerceAdapter; expiresAt: number };

const cache = new Map<string, Entry>();

export function getCachedAdapter(storeId: string): CommerceAdapter | null {
  const entry = cache.get(storeId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(storeId);
    return null;
  }
  return entry.adapter;
}

export function setCachedAdapter(storeId: string, adapter: CommerceAdapter): void {
  cache.set(storeId, { adapter, expiresAt: Date.now() + ADAPTER_TTL_MS });
}

export function invalidateCommerceAdapter(storeId: string): void {
  cache.delete(storeId);
}
