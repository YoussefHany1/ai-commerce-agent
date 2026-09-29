import { NextResponse } from 'next/server';
import { createDashboardSupabaseClient } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

/**
 * Starts a Google sign-in. The redirect target is always this app's own `/auth/callback`,
 * so the code verifier and the exchanged token stay on origin.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const supabase = createDashboardSupabaseClient();
  if (!supabase) return NextResponse.json({ error: 'auth_unavailable' }, { status: 503 });

  const origin = new URL(request.url).origin;
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${origin}/auth/callback`,
      },
    });
    if (error || !data.url) return NextResponse.json({ error: 'auth_unavailable' }, { status: 503 });
    return NextResponse.redirect(data.url);
  } catch {
    return NextResponse.json({ error: 'auth_unavailable' }, { status: 503 });
  }
}