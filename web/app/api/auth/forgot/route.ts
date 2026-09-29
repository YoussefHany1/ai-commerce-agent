import { NextResponse } from 'next/server';
import { callAuthApi } from '@/lib/server/authExchange';

export const dynamic = 'force-dynamic';

/**
 * Password recovery request. The response is uniformly successful: the API never
 * reveals whether an email is registered, so neither does this route.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: { email?: unknown };
  try {
    body = (await request.json()) as { email?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (typeof body.email !== 'string' || !body.email.trim() || body.email.length > 320) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const out = await callAuthApi('forgot', { email: body.email.trim() });
  return NextResponse.json(out.payload, { status: out.status });
}