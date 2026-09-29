import { NextResponse } from 'next/server';
import { createDashboardSupabaseClient } from '@/lib/server/supabase';
import { callAuthApi, mintSessionCookie, safeNext } from '@/lib/server/authExchange';

export const dynamic = 'force-dynamic';

/**
 * OAuth / PKCE callback target.
 *
 * `@supabase/ssr` keeps the PKCE code verifier in an HTTP-only cookie, so the code
 * can only be exchanged here, in the server runtime. The Supabase session token is
 * immediately traded for this app's own session id and dropped; the browser never
 * holds it. Any failure redirects to /login rather than rendering an error body,
 * which keeps the failed attempt unrevealing.
 *
 * This is the route where the operator/client question is settled, and it is settled
 * upstream. The same Google button serves both — an operator is a person, and people
 * arrive with the provider's session, not with a password typed into a second form —
 * so the callback cannot ask which one to mint. It exchanges the code, hands the token
 * to `/api/auth/exchange`, and writes whichever cookie the API says that token earned.
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

  const out = await callAuthApi('exchange', { accessToken });
  if (out.status !== 200) return login('auth_unavailable');

  const { buildPayload } = await import('@/lib/server/authExchange');
  const { serializeSession, sessionCookieOptions, SESSION_COOKIE } = await import('@/lib/server/session');
  const parsed = buildPayload(out.payload as any);
  if (!parsed) return login('auth_unavailable');

  const redirectTo = safeNext(url.searchParams.get('redirect_to')) ?? '/dashboard';
  const response = NextResponse.redirect(new URL(redirectTo, request.url));
  
  response.cookies.set({
    name: SESSION_COOKIE,
    value: serializeSession(parsed.payload),
    ...sessionCookieOptions(parsed.expiresIn)
  });

  return response;
}