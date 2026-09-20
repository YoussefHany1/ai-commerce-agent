import { getRedis } from './redis.js';

export type RateWindow = {
  limit: number;
  windowSec: number;
};

export function checkLimit(used: number, limit: number, windowSec: number): { exceeded: boolean; remaining: number; retryAfterSec: number } {
  return {
    exceeded: used > limit,
    remaining: Math.max(0, limit - used),
    retryAfterSec: windowSec,
  };
}

export function rateError(message = 'rate_limit_exceeded', retryAfterSec: number): Error & { statusCode: number; headers: Record<string, string> } {
  const err = Object.assign(new Error(message), {
    statusCode: 429,
    headers: { 'retry-after': String(retryAfterSec) },
  });
  return err as Error & { statusCode: number; headers: Record<string, string> };
}

export async function consumeRateLimit(key: string, window: RateWindow): Promise<void> {
  const client = await getRedis();
  const k = `rl:${key}`;
  const used = await client.incr(k);
  if (used === 1) await client.expire(k, window.windowSec);
  const { exceeded, retryAfterSec } = checkLimit(used, window.limit, window.windowSec);
  if (exceeded) throw rateError('rate_limit_exceeded', retryAfterSec);
}

export function storeKeyFrom(req: any): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const params = (req.params ?? {}) as Record<string, unknown>;
  return String(body.storeId ?? params.storeId ?? '');
}

export function reqIp(req: any): string {
  return String(req.ip ?? req.socket?.remoteAddress ?? 'unknown');
}

export function storeRateLimitWindow(scope: string, window: RateWindow) {
  return async (req: any): Promise<void> => {
    const storeId = (req.session?.storeId as string | undefined) ?? storeKeyFrom(req);
    if (storeId) {
      await consumeRateLimit(`store:${scope}:${storeId}`, window);
      return;
    }
    await consumeRateLimit(`ip:${scope}:${reqIp(req)}`, window);
  };
}