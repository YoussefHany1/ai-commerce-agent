import { getCommerceAdapter } from '../src/integrations/factory.js';

async function test() {
  try {
    const adapter = await getCommerceAdapter('b87155ac-8a3c-4e1b-873d-2c579ee0bbfe');
    if (!adapter) {
      console.log('No adapter found');
      process.exit(0);
    }
    console.log('Adapter found. Listing products...');
    const list = await adapter.listProducts();
    console.log('Products:', list.length);
  } catch (err) {
    console.error('Adapter Error:', err);
  }
  process.exit(0);
}
test();
