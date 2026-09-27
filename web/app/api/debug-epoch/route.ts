import { NextResponse } from 'next/server';
import { currentEpoch } from '@/lib/server/redis';

export const dynamic = 'force-dynamic';

/** TEMPORARY DEBUG ENDPOINT — remove after diagnosing session issue */
export async function GET(): Promise<NextResponse> {
  try {
    const epoch = await currentEpoch();
    return NextResponse.json({ epoch, ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
