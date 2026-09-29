import postgres from 'postgres';

async function probe(label, url) {
  console.log(`\n=== ${label} ===`);
  let sql;
  try {
    sql = postgres(url, { max: 1, connect_timeout: 15 });
    const tables = await sql`
      select table_name from information_schema.tables
      where table_schema='public' and table_type='BASE TABLE' order by 1`;
    console.log('tables:', tables.map((r) => r.table_name).join(', '));
    if (tables.some((r) => r.table_name === 'clients')) {
      const cols = await sql`
        select column_name, is_nullable from information_schema.columns
        where table_schema='public' and table_name='clients' order by ordinal_position`;
      console.log('clients cols:', cols.map((r) => `${r.column_name}${r.is_nullable === 'YES' ? '?' : ''}`).join(', '));
    }
    const fn = await sql`select count(*)::int c from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='auth_jwt'`;
    console.log('public.auth_jwt() exists:', fn[0].c);
    const roles = await sql`select rolname from pg_roles where rolname::text like '%authenticated%' or rolname in ('service_role','anon','agent_app')`;
    console.log('relevant roles:', roles.map((r) => r.rolname).join(', '));
    const pol = await sql`select count(*)::int c from pg_policies where schemaname='public' and policyname like 'tenant\_%'`;
    console.log('tenant_* policies:', pol[0].c);
    const rel = await sql`select current_database() db, current_user usr`;
    console.log('connected as:', rel[0].usr, '@', rel[0].db);
    await sql.end();
  } catch (err) {
    console.log('probe failed:', err.message);
    if (sql) await sql.end({ timeout: 3 }).catch(() => {});
  }
}

await probe('DATABASE_URL (supabase.co)', process.env.DATABASE_URL);
await probe('TEST/DIRECT app db', process.argv.find((a) => a.startsWith('--url='))?.slice(6));
if (process.env.PGADMIN_URL) await probe('PGADMIN_URL (neon.tech)', process.env.PGADMIN_URL);