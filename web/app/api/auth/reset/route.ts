import { NextResponse } from 'next/server';
import { createDashboardSupabaseClient } from '@/lib/server/supabase';
import { callClientAuth, mintClientSessionCookie } from '@/lib/server/clientExchange';

export const dynamic = 'force-dynamic';

const EMAIL_MAX = 320;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 1024;

/**
 * Completes a password reset from the email's recovery link.
 *
 * Body {email, token, password}: the `token`/`type=recovery` parameters out of
 * the Supabase email link, plus the new password. The BFF verifies the one-time
 * token with `verifyOtp` and rotates the password (`updateUser`), then finishes
 * the two API calls the reset needs:
 *   - reset-complete  bumps the account epoch, killing every pre-reset session;
 *   - exchange        mints a fresh session against the moved epoch.
 * The fresh access token is read *after* updateUser — password rotation can roll
 * the session tokens, and using a stale token would bounce off the API.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: { email?: unknown; token?: unknown; password?: unknown };
  try {
    body = (await request.json()) as { email?: unknown; token?: unknown; password?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (
    typeof body.email !== 'string' ||
    !body.email.trim() ||
    body.email.length > EMAIL_MAX ||
    typeof body.token !== 'string' ||
    !body.token ||
    typeof body.password !== 'string' ||
    !body.password ||
    body.password.length > PASSWORD_MAX ||
    body.password.length < PASSWORD_MIN
  ) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const email = body.email.trim();
  const supabase = createDashboardSupabaseClient();
  if (!supabase) return NextResponse.json({ error: 'auth_unavailable' }, { status: 503 });

  let verified: { session: { access_token: string } } | null = null;
  try {
    const { data, error } = await supabase.auth.verifyOtp({ type: 'recovery', email, token: body.token });
    if (error || !data.session) {
      // Both "wrong token" and "expired link" land here; refusable but unrevealing.
      return NextResponse.json({ error: 'invalid_link' }, { status: 400 });
    }
    verified = { session: data.session };
  } catch {
    return NextResponse.json({ error: 'auth_unavailable' }, { status: 503 });
  }

  try {
    const { error } = await supabase.auth.updateUser({ password: body.password });
    if (error) return NextResponse.json({ error: 'invalid_link' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'auth_unavailable' }, { status: 503 });
  }

  const { data: after } = await supabase.auth.getSession();
  const accessToken = after.session?.access_token ?? verified.session.access_token;

  const bump = await callClientAuth('reset-complete', { accessToken });
  if (bump.status !== 200) return NextResponse.json(bump.payload, { status: bump.status });

  const exchange = await callClientAuth('exchange', { accessToken });
  if (exchange.status !== 200) return NextResponse.json(exchange.payload, { status: exchange.status });

  const minted = await mintClientSessionCookie(exchange.payload);
  if (!minted) return NextResponse.json({ error: 'auth_unavailable' }, { status: 503 });
  return NextResponse.json({ ok: true });
}