import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createDashboardSupabaseClient } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

/**
 * Starts a Google sign-in. The redirect target is always this app's own `/auth/callback`,
 * so the code verifier and the exchanged token stay on origin.
 *
 * @supabase/ssr stores the PKCE code verifier in cookies via its `setAll` handler,
 * which writes to Next's cookie store (next/headers). Those cookies are written as
 * part of the response by Next automatically — no manual copying needed. The redirect
 * response will carry the Set-Cookie headers that Next's cookie store accumulated.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const supabase = createDashboardSupabaseClient();
  if (!supabase) return NextResponse.json({ error: 'auth_unavailable', reason: 'SUPABASE_URL or SUPABASE_ANON_KEY is missing in env' }, { status: 503 });

  // Ensure the cookie store is accessed so Next includes any Set-Cookie headers
  // that Supabase writes (e.g. the PKCE code verifier) on the redirect response.
  await cookies();

  const origin = new URL(request.url).origin;
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${origin}/auth/callback`,
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    });
    if (error || !data.url) return NextResponse.json({ error: 'auth_unavailable', details: error?.message || 'no url returned' }, { status: 503 });
    return NextResponse.redirect(data.url);
  } catch (e: any) {
    return NextResponse.json({ error: 'auth_unavailable', exception: e?.message }, { status: 503 });
  }
}