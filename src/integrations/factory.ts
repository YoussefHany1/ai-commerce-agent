import type { CommerceAdapter, Platform } from '../types.js';
import { connectionRepo, storeRepo } from '../db/repos.js';
import { ShopifyAdapter } from './shopify.js';
import { SallaAdapter } from './salla.js';
import { ZidAdapter } from './zid.js';

/**
 * Builds an adapter from credentials held in hand rather than in the database.
 *
 * Shared with {@link verifyStoreCredentials} so the pre-install check exercises the
 * same constructor the sync workers will later use. A credential accepted here is a
 * credential the adapter can actually be built from, which is the property that
 * matters — the old failure mode was a store row with no token, so no adapter could
 * ever be constructed and every sync job died with `no_connection`.
 *
 * `zidAuthorization` is the one input that cannot be typed by hand: it is issued by
 * the Zid OAuth callback and stored in `stores.settings`, so a manually created Zid
 * store has no way to obtain it and can never build an adapter at all.
 */
function buildAdapter(
  // `string`, not `Platform`: `stores.platform` is a text column, so a row read back
  // from the database is wider than the union. The switch's `default` is what turns
  // an unrecognised value into "no adapter", exactly as before.
  platform: string,
  shopDomain: string | null | undefined,
  accessToken: string,
  zidAuthorization?: string | null,
): CommerceAdapter | null {
  switch (platform) {
    case 'shopify':
      if (!shopDomain) return null;
      return new ShopifyAdapter(shopDomain, accessToken);
    case 'salla':
      return new SallaAdapter(accessToken);
    case 'zid': {
      if (!zidAuthorization) return null;
      return new ZidAdapter(accessToken, zidAuthorization);
    }
    default:
      return null;
  }
}

export type CredentialCheck =
  | { ok: true }
  | { ok: false; code: 'missing_shop_domain' | 'zid_requires_oauth' | 'unreachable'; message: string };

/**
 * Proves a set of pasted credentials can actually build an adapter and reach the
 * platform, before the store row is written.
 *
 * Returns a discriminated result rather than throwing: the caller turns these into
 * a 4xx with an actionable code, and a failure here is a user-input problem, not an
 * internal error. The `unreachable` code is deliberately distinct from a rejected
 * token so the UI can say "we could not reach Shopify" instead of "your token is
 * wrong" when the network is what actually failed.
 */
export async function verifyStoreCredentials(input: {
  platform: Platform;
  shopDomain?: string | null;
  accessToken: string;
}): Promise<CredentialCheck> {
  if (input.platform === 'shopify' && !input.shopDomain) {
    return { ok: false, code: 'missing_shop_domain', message: 'Shopify needs a shop domain' };
  }
  if (input.platform === 'zid') {
    return {
      ok: false,
      code: 'zid_requires_oauth',
      message: 'Zid stores can only be connected through the Zid OAuth flow',
    };
  }

  const adapter = buildAdapter(input.platform, input.shopDomain, input.accessToken);
  if (!adapter) {
    return { ok: false, code: 'unreachable', message: 'Could not build a client for this platform' };
  }

  try {
    // Every adapter implements `verify`; the optional type only exists so an older
    // adapter or a test double degrades to a scoped read instead of blocking install.
    if (adapter.verify) {
      await adapter.verify();
    } else {
      await adapter.listProducts();
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'unreachable', message };
  }
}

export async function getCommerceAdapter(storeId: string): Promise<CommerceAdapter | null> {
  const store = await storeRepo.get(storeId);
  if (!store) return null;

  let conn = await connectionRepo.get(storeId);
  if (!conn) return null;

  const ok = await connectionRepo.refreshIfExpired(storeId);
  if (!ok) return null;

  conn = await connectionRepo.get(storeId);
  if (!conn) return null;

  const accessToken = connectionRepo.decryptToken(conn);
  if (!accessToken) return null;

  const zidAuthorization =
    store.platform === 'zid' ? await storeRepo.getSecret(storeId, 'zidAuthorization') : null;

  return buildAdapter(store.platform, store.shopDomain, accessToken, zidAuthorization);
}