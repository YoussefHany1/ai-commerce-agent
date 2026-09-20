import { storeRepo } from '../src/db/repos.js';

async function test() {
  try {
    const res = await storeRepo.get('b87155ac-8a3c-4e1b-873d-2c579ee0bbfe');
    console.log('Result:', res);
  } catch (err) {
    console.error('Error:', err);
  }
  process.exit(0);
}
test();
