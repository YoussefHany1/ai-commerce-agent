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
 * IMPORTANT: `@supabase/ssr` expects `getAll` and `setAll` to be SYNCHRONOUS
 * functions returning/accepting the cookie list directly. Passing async functions
 * (even ones that resolve immediately) causes `getAll` to return a Promise object
 * instead of a cookie array — Supabase then sees zero cookies, cannot find the
 * PKCE code verifier, and `exchangeCodeForSession` fails with
 * `AuthPKCECodeVerifierMissingError`. The fix is to resolve `cookies()` once
 * before constructing the client and capture the store in a variable that the
 * synchronous callbacks close over.
 */
export async function createDashboardSupabaseClient() {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) return null;

  // Resolve the Next.js cookie store ONCE, synchronously accessible to both callbacks.
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => {
        const all = cookieStore.getAll();
        // DEBUG: log cookie names so we can verify the PKCE verifier is arriving
        console.log('[supabase-client] getAll() returning cookies:', all.map(c => c.name));
        return all;
      },
      setAll: (list) => {
        for (const { name, value, options } of list) {
          cookieStore.set(name, value, options);
        }
      },
    },
  });
}

/** True when this service can complete a Supabase flow end to end. */
export function supabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_ANON_KEY?.trim());
}