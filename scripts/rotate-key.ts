import postgres from 'postgres';
import { config } from '../src/config.js';
import { decryptKey, encryptKey, keyVersionOf } from '../src/lib/encryption.js';

const admin = postgres(process.env.PGADMIN_URL?.trim() || 'postgres://postgres:postgres@localhost:5432/ai_commerce_agent', {
  max: 1,
  onnotice: () => {},
});

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