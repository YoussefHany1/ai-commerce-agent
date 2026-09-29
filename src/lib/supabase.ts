import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { config } from '../config.js';

/**
 * Supabase Auth/Postgres clients.
 *
 * The API never runs the browser SDK: sessions are minted and verified server-side
 * against the Admin API (`auth.admin.getUser(token)`), and passwords go through
 * `signInWithPassword` here rather than in the dashboard. Both clients are
 * stateless (no persistSession / autoRefreshToken) because cookies belong to the
 * web BFF, not this service.
 *
 * Both constructors return null when the corresponding env vars are missing, so
 * every calling route can fail closed with a 503 instead of pretending client
 * identity still works. Tests mock this module wholesale.
 */

export function supabaseAnon(): SupabaseClient | null {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = config;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function supabaseAdmin(): SupabaseClient | null {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = config;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** True when the service is provisioned to act as Supabase's client-identity backend. */
export function supabaseConfigured(): boolean {
  return supabaseAnon() !== null && supabaseAdmin() !== null;
}

/** The few admin paths that would otherwise know an email only by primary key. */
const USER_LOOKUP_PAGE_CAP = 20;

/**
 * Resolves an existing auth user by email. GoTrue exposes no id-by-email endpoint,
 * so this pages through `admin.listUsers` — fine because it only runs on the
 * rare user_already_exists collision, and capped so a pathological directory
 * cannot balloon a call.
 */
export async function findSupabaseUserByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<User | null> {
  const needle = email.trim().toLowerCase();
  for (let page = 1; page <= USER_LOOKUP_PAGE_CAP; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return null;
    if (!data?.users?.length) return null;
    const hit = data.users.find((u) => u.email?.toLowerCase() === needle);
    if (hit) return hit;
  }
  return null;
}