import type { CommerceAdapter } from '../types.js';
import { connectionRepo, storeRepo } from '../db/repos.js';
import { ShopifyAdapter } from './shopify.js';
import { SallaAdapter } from './salla.js';
import { ZidAdapter } from './zid.js';

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

  switch (store.platform) {
    case 'shopify':
      if (!store.shopDomain) return null;
      return new ShopifyAdapter(store.shopDomain, accessToken);
    case 'salla':
      return new SallaAdapter(accessToken);
    case 'zid': {
      const authorization = await storeRepo.getSecret(storeId, 'zidAuthorization');
      if (!authorization) return null;
      return new ZidAdapter(accessToken, authorization);
    }
    default:
      return null;
  }
}