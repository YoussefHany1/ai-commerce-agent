import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createDashboardSupabaseClient } from '@/lib/server/supabase';
import { buildPayload, callAuthApi, safeNext } from '@/lib/server/authExchange';
import { SESSION_COOKIE, serializeSession, sessionCookieOptions } from '@/lib/server/session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

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
 *
 * IMPORTANT: The session cookie is set directly on the NextResponse.redirect() object
 * rather than via next/headers cookies(). In Next.js Route Handlers, cookies written
 * via next/headers are not reliably transferred to a redirect response — the Set-Cookie
 * header can be lost, leaving the browser with no session cookie and the middleware
 * sending the user straight back to /login. Setting the cookie on the response directly
 * guarantees it is included in the redirect's Set-Cookie header.
 */
export async function GET(request: Request): Promise<NextResponse> {
  // Opt into dynamic rendering immediately
  const { headers: nextHeaders } = await import('next/headers');
  await nextHeaders();

  const login = (error: string) => NextResponse.redirect(new URL(`/login?error=${error}`, request.url));

  const url = new URL(request.url);
  const code = url.searchParams.get('code');

  // DEBUG: log cookies present so we can verify the PKCE verifier arrived
  const cookieHeader = request.headers.get('cookie') ?? '';
  const cookieNames = cookieHeader.split(';').map(c => c.trim().split('=')[0]).filter(Boolean);
  console.log('[auth/callback] cookies present:', cookieNames);
  console.log('[auth/callback] has code:', !!code);

  if (!code) {
    console.error('[auth/callback] No code in callback URL');
    return login('auth_callback');
  }

  const supabase = await createDashboardSupabaseClient();
  if (!supabase) {
    console.error('[auth/callback] Supabase client unavailable (missing env vars)');
    return login('auth_unavailable');
  }

  let exchangeResult: Awaited<ReturnType<typeof supabase.auth.exchangeCodeForSession>>;
  try {
    exchangeResult = await supabase.auth.exchangeCodeForSession(code);
  } catch (e) {
    console.error('[auth/callback] exchangeCodeForSession threw:', e);
    return login('auth_unavailable');
  }
  if (exchangeResult.error || !exchangeResult.data.session?.access_token) {
    console.error('[auth/callback] exchangeCodeForSession failed:', exchangeResult.error?.message, exchangeResult.error);
    return login('auth_callback');
  }
  const accessToken = exchangeResult.data.session.access_token;

  const out = await callAuthApi('exchange', { accessToken });
  if (out.status !== 200) {
    console.error('[auth/callback] API exchange failed with status', out.status, out.payload);
    return login('auth_unavailable');
  }

  // Build the session payload from the API response. buildPayload validates that every
  // required field is present; a partial or unexpected answer returns null instead of
  // producing a cookie that the proxy would then reject on the first request.
  const built = buildPayload(out.payload);
  if (!built) {
    console.error('[auth/callback] buildPayload failed — incomplete payload:', out.payload);
    return login('auth_unavailable');
  }

  // Write the session cookie directly onto the redirect response rather than via
  // next/headers. Cookies set through next/headers in a Route Handler are not
  // reliably propagated to the redirect's Set-Cookie header in all Next.js versions,
  // which would leave the browser cookieless and trigger another /login redirect.
  const redirectTo = safeNext(url.searchParams.get('redirect_to')) ?? '/dashboard';
  
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, serializeSession(built.payload), sessionCookieOptions(built.expiresIn));
  
  console.log('[auth/callback] success - session minted, kind:', built.payload.kind, 'redirect:', redirectTo);
  
  return NextResponse.redirect(new URL(redirectTo, request.url));
}