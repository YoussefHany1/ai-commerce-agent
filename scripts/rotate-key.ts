import postgres from 'postgres';
import { config } from '../src/config.js';
import { decryptKey, encryptKey, keyVersionOf } from '../src/lib/encryption.js';

const admin = postgres(process.env.PGADMIN_URL?.trim() || 'postgres://postgres:postgres@localhost:5432/ai_commerce_agent', {
  max: 1,
  onnotice: () => {},
});

// 0007_force_rls subjects the table owner to RLS, so DML run over PGADMIN_URL
// only takes effect if the tenant_operator_* policies are satisfied. Harmless
// when PGADMIN_URL is a superuser (which bypasses RLS regardless) and required
// when it is a non-superuser owner - without this the updates below would
// silently match zero rows, the same failure mode as commit ac0a2de. The claim
// is the identity carrier policies read since 0010 (`app.operator` GUC is gone).
await admin`select set_config('request.jwt.claims', '{"app":{"operator":"true"}}', false)`;

const target = config.encryption.version;
if (!config.encryption.keys[target]) {
  throw new Error(`no encryption key registered for active version ${target}`);
}

const rows = await admin`select id, access_token_enc, refresh_token_enc from platform_connections`;

let rotated = 0;
for (const row of rows) {
  const updates: Record<string, unknown> = {};
  if (row.access_token_enc && keyVersionOf(row.access_token_enc) !== target) {
    updates.access_token_enc = encryptKey(decryptKey(row.access_token_enc), target);
  }
  if (row.refresh_token_enc && keyVersionOf(row.refresh_token_enc) !== target) {
    updates.refresh_token_enc = encryptKey(decryptKey(row.refresh_token_enc), target);
  }
  if (Object.keys(updates).length) {
    updates.key_version = target;
    await admin`update platform_connections set ${admin(updates)} where id = ${row.id}`;
    rotated++;
  }
}

const wa = await admin`select id, access_token_enc, key_version from whatsapp_channels`;
for (const row of wa) {
  const updates: Record<string, unknown> = {};
  if (row.access_token_enc && keyVersionOf(row.access_token_enc) !== target) {
    updates.access_token_enc = encryptKey(decryptKey(row.access_token_enc), target);
  }
  if (Object.keys(updates).length) {
    updates.key_version = target;
    await admin`update whatsapp_channels set ${admin(updates)} where id = ${row.id}`;
    rotated++;
  }
}

await admin.end();
console.log(`rotated ${rotated} connections to key version ${target}`);