import { bumpOperatorSessionEpoch } from '../src/lib/operatorSession.js';

/**
 * Invalidates every operator dashboard session by bumping the session epoch.
 *
 * Run this after changing OPERATOR_PASSWORD_HASH, or whenever a session cookie
 * is suspected to have leaked. The epoch lives in Redis, so this takes effect
 * for every web replica immediately.
 */

const epoch = await bumpOperatorSessionEpoch();
console.log(`operator session epoch bumped to ${epoch}; all outstanding dashboard sessions are now invalid`);
