import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Supabase Auth client scoped to the web server runtime.
 *
 * Used only where the BFF must complete a Supabase-managed flow that the browser
 * cannot: the PKCE callback (`exchangeCodeForSession` needs the code verifier
 * that @supabase/ssr keeps in an HTTP-only cookie) and the password-reset OTP
 * path (`verifyOtp`). The tokens produced here are *never* left in the browser:
 * they are traded for this app's own session id via the API's `exchange` route,
 * which is what mints the `aca_session` cookie.
 *
 * `getAll`/`setAll` cover the async `cookies()` API in Next 16. The Supabase auth
 * cookies (sb-…) are set on the response exactly where the SDK needs them —
 * primarily the PKCE verifier — and are short-lived by design.
 */
export function createDashboardSupabaseClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;
  return createServerClient(url, anonKey, {
    cookies: {
      // `getAll` returns {name, value}[] — the shape @supabase/ssr expects.
      getAll: async () => (await cookies()).getAll(),
      setAll: async (list) => {
        const store = await cookies();
        for (const { name, value, options } of list) {
          store.set(name, value, options);
        }
      },
    },
  });
}

/** True when this service can complete a Supabase flow end to end. */
export function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_ANON_KEY?.trim());
}