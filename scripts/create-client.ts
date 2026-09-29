import { randomBytes } from 'node:crypto';
import { clientRepo } from '../src/db/repos.js';
import { normalizeEmail } from '../src/routes/clientAuth.js';
import { supabaseAdmin } from '../src/lib/supabase.js';

/**
 * Invites a dashboard client account by creating its Supabase Auth identity and
 * the matching account row. Accounts are invite-only; this is the operator-side
 * ingestion path alongside POST /api/clients.
 *
 *   npm run client:create -- "Acme Inc" acme@example.com
 *
 * Prints the account's one-time password exactly once. Nothing forces a change on
 * first login; the client can switch to a password of their own afterwards via the
 * authenticated change-password route (POST /api/auth/client/password, which revokes
 * every other device) or the email recovery link (Dashboard → Forgot password).
 */

const TEMP_LENGTH = 16;

async function main(): Promise<void> {
  const [name, email] = process.argv.slice(2);
  if (!name || !email) {
    console.error('Usage: npm run client:create -- "<display name>" <email@example.com>');
    process.exit(1);
  }
  if (!email.includes('@')) {
    console.error('A valid email address is required.');
    process.exit(1);
  }

  const normalized = normalizeEmail(email);
  if (await clientRepo.findByEmail(normalized)) {
    console.error(`An account already exists for ${normalized}.`);
    process.exit(1);
  }

  const admin = supabaseAdmin();
  if (!admin) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to invite a client.');
    process.exit(1);
  }

  // 16 lowercase letters — a human-typable invite code, not a pet name.
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const password = Array.from(randomBytes(TEMP_LENGTH))
    .map((b) => chars[b % chars.length])
    .join('');

  let uid: string;
  try {
    const { data, error } = await admin.auth.admin.createUser({
      email: normalized,
      password,
      email_confirm: true,
    });
    if (error) {
      console.error(`Supabase could not create the identity: ${error.message}`);
      process.exit(1);
    }
    uid = data.user.id;
  } catch (err) {
    console.error(err);
    process.exit(1);
  }

  const id = await clientRepo.create({ name, email: normalized, passwordHash: null, supabaseUid: uid });

  console.log(`Created client "${name}" (${normalized}, id ${id}).`);
  console.log('Temporary password (shown once, change it on first login):');
  console.log(password);
}

await main();