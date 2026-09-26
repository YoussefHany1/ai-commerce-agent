import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE, clearedSessionCookieOptions } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  (await cookies()).set(SESSION_COOKIE, '', clearedSessionCookieOptions());
  return NextResponse.json({ ok: true });
}
