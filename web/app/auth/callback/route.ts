import { NextResponse } from 'next/server';
import { createDashboardSupabaseClient } from '@/lib/server/supabase';
import { callClientAuth, mintClientSessionCookie, safeNext } from '@/lib/server/clientExchange';

export const dynamic = 'force-dynamic';

/**
 * OAuth / PKCE callback target.
 *
 * `@supabase/ssr` keeps the PKCE code verifier in an HTTP-only cookie, so the code
 * can only be exchanged here, in the server runtime. The Supabase session token is
 * immediately traded for this app's own session id and dropped; the browser never
 * holds it. Any failure redirects to /login rather than rendering an error body,
 * which keeps the failed attempt unrevealing.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const login = (error: string) => NextResponse.redirect(new URL(`/login?error=${error}`, request.url));

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  if (!code) return login('auth_callback');

  const supabase = createDashboardSupabaseClient();
  if (!supabase) return login('auth_unavailable');

  try {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return login('auth_callback');
  } catch {
    return login('auth_unavailable');
  }

  const { data, error: getError } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (getError || !accessToken) return login('auth_callback');

  const out = await callClientAuth('exchange', { accessToken });
  if (out.status !== 200) return login('auth_unavailable');

  const minted = await mintClientSessionCookie(out.payload);
  if (!minted) return login('auth_unavailable');

  return NextResponse.redirect(new URL(safeNext(url.searchParams.get('redirect_to')) ?? '/dashboard', request.url));
}