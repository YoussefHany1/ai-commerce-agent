import { getCommerceAdapter } from '../src/integrations/factory.js';
import { connectionRepo } from '../src/db/repos.js';

async function test() {
  const storeId = 'ecd872af-ff68-42f3-83ef-7d484202db28';
  try {
    const conn = await connectionRepo.get(storeId);
    if (!conn) { console.log('no conn'); process.exit(0); }
    const token = connectionRepo.decryptToken(conn);
    const shop = conn.shopDomain;

    console.log('Querying shop { name }...');
    const r = await fetch(`https://${shop}/admin/api/2023-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token!,
      },
      body: JSON.stringify({ query: '{ shop { name } }' }),
    });
    console.log('Status:', r.status);
    const j = await r.json();
    console.log('Response:', JSON.stringify(j));
  } catch (err) {
    console.error('Error:', err);
  }
  process.exit(0);
}
test();
