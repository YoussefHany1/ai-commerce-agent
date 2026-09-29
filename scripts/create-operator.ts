import { supabaseAdmin, findSupabaseUserByEmail } from '../src/lib/supabase.js';
import { clientRepo, operatorRepo } from '../src/db/repos.js';
import { config } from '../src/config.js';

/**
 * Provisions an operator: one `operators` row bound to one Supabase identity.
 *
 * This replaces `hash-operator-password.ts`. That script produced a scrypt hash for
 * OPERATOR_PASSWORD_HASH — a single install-wide password, where knowing it made you an
 * administrator and changing it logged out everybody. There is nothing to hash now: the
 * credential belongs to a person, and Supabase owns it.
 *
 * The identity is created with `email_confirm: true` and a random password that is never
 * printed, because the API has no mailer and so cannot send a confirmation. Instead a
 * single-use recovery link is printed for you to hand over. Whoever opens it sets their
 * own password. The random password is not a backdoor: it is never disclosed, and the
 * recovery link rotates it.
 *
 *   npm run operator:create -- --name "Youssef" --email you@example.com
 *   npm run operator:create -- --name "Youssef" --email you@example.com --link
 *
 * `--link` prints only the recovery link, for the case where the operator already exists
 * in Supabase (a Google sign-in) and you just need to hand them a way to set a password.
 *
 * Requires migration 0012 to have been applied.
 */

const RESET_REDIRECT = 'login/reset';

function arg(name: string): string | undefined {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
}

const EMAIL_MAX = 320;
const NAME_MAX = 120;

async function main(): Promise<void> {
  const admin = supabaseAdmin();
  if (!admin) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to create an operator.');
    process.exit(1);
  }

  const email = (arg('email') ?? '').trim().toLowerCase();
  if (!email || !email.includes('@') || email.length > EMAIL_MAX) {
    console.error('--email must be a valid address.');
    process.exit(1);
  }

  const name = (arg('name') ?? email.split('@')[0]).trim();
  if (!name || name.length > NAME_MAX) {
    console.error('--name must be 1-' + NAME_MAX + ' characters.');
    process.exit(1);
  }

  // A Supabase uid may identify at most one local row. If this address is already a
  // merchant here, the operator invite has to be refused, or the recovery link below
  // would hand an administrator's credentials to somebody who also owns a store.
  const asClient = await clientRepo.findByEmail(email);
  if (asClient) {
    console.error(`${email} is already a client account on this install. Refusing to also make it an operator.`);
    process.exit(1);
  }

  const existingOperator = await operatorRepo.findByEmail(email);
  if (existingOperator && !arg('link')) {
    console.error(`${email} is already an operator (${existingOperator.id}, ${existingOperator.status}).`);
    console.error('Pass --link to just re-print a recovery link, or revoke and recreate for a new one.');
    process.exit(1);
  }

  const redirectTo = new URL(RESET_REDIRECT, config.APP_BASE_URL).toString();

  let uid = existingOperator?.supabaseUid ?? null;
  let reused = false;

  const existingIdentity = await findSupabaseUserByEmail(admin, email);
  if (existingIdentity) {
    // Reuse, never re-create: a second identity for one address would leave an orphaned
    // auth user and make the uid the operator row points at ambiguous.
    uid = existingIdentity.id;
    reused = true;
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      // Random and undisclosed. The recovery link is the only way in, and it rotates
      // this value, so nothing here is a credential anyone can use.
      password: `${crypto.randomUUID()}-${crypto.randomUUID()}`,
      email_confirm: true,
      user_metadata: { operatorEmail: email },
    });
    if (error) {
      console.error(`Supabase createUser failed: ${error.message}`);
      process.exit(1);
    }
    uid = data.user.id;
  }

  const clientClash = await clientRepo.getBySupabaseUid(uid as string);
  if (clientClash) {
    console.error(
      `Supabase identity ${uid} is already linked to client account ${clientClash.id}. Refusing to bind it to an operator.`,
    );
    process.exit(1);
  }

  if (existingOperator) {
    if (existingOperator.supabaseUid !== uid) {
      await operatorRepo.setSupabaseUid(existingOperator.id, uid);
      console.log(`linked existing operator ${existingOperator.name} (${existingOperator.id}) -> ${uid}`);
    }
  } else {
    const id = await operatorRepo.create({ name, email, supabaseUid: uid });
    console.log(`created operator ${name} <${email}> (${id}) -> ${uid}${reused ? ' (reused existing identity)' : ''}`);
  }

  const { data, error } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email,
    options: { redirectTo },
  });
  if (error || !data.properties) {
    console.error(`\nThe operator row exists, but the recovery link failed: ${error?.message ?? 'no properties'}`);
    console.error('Re-run with --link to retry. Do not delete the row: the identity is already bound to it.');
    process.exit(1);
  }

  console.log('\nSign-in link (single use, expires in 24h). Send it to the operator over a channel you trust:');
  console.log(`  ${data.properties.action_link}`);
  console.log('\nThey set their own password on that link. Afterwards they sign in with email + password, or Google.');
}

await main();
