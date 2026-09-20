import { getCommerceAdapter } from '../src/integrations/factory.js';
import { connectionRepo } from '../src/db/repos.js';

async function test() {
  const storeId = 'ecd872af-ff68-42f3-83ef-7d484202db28';
  try {
    const conn = await connectionRepo.get(storeId);
    console.log('Scopes for new store:', conn?.scopes);

    const adapter = await getCommerceAdapter(storeId);
    if (!adapter) {
      console.log('No adapter found');
      process.exit(0);
    }
    console.log('Listing products...');
    const list = await adapter.listProducts();
    console.log('Success! Products:', list.length);
  } catch (err) {
    console.error('Error:', err);
  }
  process.exit(0);
}
test();
