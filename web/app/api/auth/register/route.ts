import { NextResponse } from 'next/server';
import { callAuthApi } from '@/lib/server/authExchange';

export const dynamic = 'force-dynamic';

const NAME_MAX = 200;
const EMAIL_MAX = 320;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 1024;

/**
 * Self-service registration. Body {name, email, password}; the API creates the
 * Supabase identity already confirmed and the account row, so the account is usable
 * immediately — no confirmation link to wait on.
 * Failures map to the API's own codes so the form can show the right message:
 * 503 while Supabase is unavailable, otherwise a uniform success like the API's.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: { name?: unknown; email?: unknown; password?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; email?: unknown; password?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  if (
    typeof body.name !== 'string' ||
    !body.name.trim() ||
    body.name.length > NAME_MAX ||
    typeof body.email !== 'string' ||
    !body.email.trim() ||
    body.email.length > EMAIL_MAX ||
    typeof body.password !== 'string' ||
    !body.password ||
    body.password.length > PASSWORD_MAX ||
    body.password.length < PASSWORD_MIN
  ) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const out = await callAuthApi('client/register', {
    name: body.name.trim(),
    email: body.email.trim(),
    password: body.password,
  });
  return NextResponse.json(out.payload, { status: out.status });
}