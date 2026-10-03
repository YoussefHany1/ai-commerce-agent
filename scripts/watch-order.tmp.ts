import postgres from 'postgres';

const sql = postgres((process.env.PGADMIN_URL || process.env.DATABASE_URL || '').trim(), {
  max: 1,
  onnotice: () => {},
  connect_timeout: 20,
  ssl: 'require',
});

for (let i = 0; i < 5; i += 1) {
  const rows = await sql`
    select store_id, status, phone, last_error,
           extract(epoch from (now() - "updatedAt"))::int as age_s, "updatedAt"
    from whatsapp_baileys_sessions order by "updatedAt" desc`;
  console.log(`--- t+${i * 25}s (${rows.length} session rows) ---`);
  for (const r of rows) console.log(r);
  await new Promise((r) => setTimeout(r, 25_000));
}

await sql.end({ timeout: 5 });
