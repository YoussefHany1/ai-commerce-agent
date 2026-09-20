import { connectionRepo } from '../src/db/repos.js';

async function test() {
  try {
    const tokens = await connectionRepo.getTokens('b87155ac-8a3c-4e1b-873d-2c579ee0bbfe');
    console.log('Scopes stored:', tokens?.scopes);
  } catch (err) {
    console.error('Error:', err);
  }
  process.exit(0);
}
test();
