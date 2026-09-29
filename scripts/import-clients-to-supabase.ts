import { randomBytes } from 'node:crypto';
import { clientRepo } from '../src/db/repos.js';
import { supabaseAdmin, findSupabaseUserByEmail } from '../src/lib/supabase.js';
import { config } from '../src/config.js';

/**
 * One-shot promotion of legacy scrypt accounts to Supabase Auth.
 *
 * For every account that still lacks a `supabase_uid`, this script:
 *   1. reuses the Supabase identity when one already exists for the email, or
 *      creates it (`email_confirm: true`; no email is sent, so nothing depends
 *      on Supabase SMTP),
 *   2. links the account row by setting `supabase_uid` — which also withdraws
 *      the legacy scrypt hash, so the account can only sign in through Supabase
 *      from that point on,
 *   3. prints a recovery link (admin-generated `recovery` link) for the operator
 *      to forward — clicking it lets the client set their own password. This is
 *      the "our own email template" part of the migration: the link is delivered
 *      by the operator because the API has no mailer; wiring up SMTP later lets
 *      the same link ride Supabase's recovery email instead.
 *
 * Idempotent: already-linked accounts are skipped, and an identity that exists
 * but was never linked is linked rather than re-created.
 *
 *   npm run client:import-supabase
 */

const RESET_REDIRECT = 'login/reset';

async function main(): Promise<void> {
  const admin = supabaseAdmin();
  if (!admin) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to import clients.');
    process.exit(1);
  }

  const clients = await clientRepo.list();
  const pending = clients.filter((c) => !c.supabaseUid);
  if (pending.length === 0) {
    console.log(`All ${clients.length} client accounts are already Supabase-managed.`);
    return;
  }
  console.log(`${pending.length} of ${clients.length} accounts need import:`);

  const redirectTo = new URL(RESET_REDIRECT, config.APP_BASE_URL).toString();
  let linked = 0;
  let created = 0;

  for (const client of pending) {
    let uid: string;
    const existing = await findSupabaseUserByEmail(admin, client.email);
    if (!existing) {
      const password = randomBytes(18).toString('base64url').slice(0, 24);
      const { data, error } = await admin.auth.admin.createUser({
        email: client.email,
        password,
        email_confirm: true,
        user_metadata: { clientId: client.id },
      });
      if (error) {
        console.error(`  ${client.email}: create failed (${error.message})`);
        continue;
      }
      uid = data.user.id;
      created += 1;
    } else {
      uid = existing.id;
      linked = linked + 1;
    }

    await clientRepo.setSupabaseUid(client.id, uid);

    // `recovery` links are single-use; the printed one is the only credential
    // path, so the operator must forward it before the link's 24h expiry.
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: client.email,
      options: { redirectTo },
    });
    if (error || !data.properties) {
      console.error(`  ${client.email}: linked, but recovery link failed (${error?.message ?? 'no properties'})`);
      continue;
    }
    console.log(`  ${client.email} -> ${uid}`);
    console.log(`    recovery: ${data.properties.action_link}`);
  }
  console.log(`\nDone: ${created} created, ${linked} reused existing identities.`);
}

await main();