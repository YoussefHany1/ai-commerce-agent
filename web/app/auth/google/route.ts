import { NextResponse } from 'next/server';
import { createDashboardSupabaseClient } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

/**
 * Starts a Google sign-in. The redirect target is always this app's own `/auth/callback`,
 * so the code verifier and the exchanged token stay on origin.
 *
 * `createDashboardSupabaseClient` resolves the cookie store before constructing the
 * Supabase client, so the `setAll` callback that writes the PKCE verifier is synchronous
 * and can be called immediately by @supabase/ssr without waiting on a Promise.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const supabase = await createDashboardSupabaseClient();
  if (!supabase) return NextResponse.json({ error: 'auth_unavailable', reason: 'SUPABASE_URL or SUPABASE_ANON_KEY is missing in env' }, { status: 503 });

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