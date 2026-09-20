import type { Platform } from '../types.js';
import { config } from '../config.js';

export type RefreshResult = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
};

export async function refreshProviderToken(
  platform: Platform,
  refreshToken: string,
): Promise<RefreshResult | null> {
  switch (platform) {
    case 'shopify':
      return null;
    case 'salla':
      return refreshSalla(refreshToken);
    case 'zid':
      return refreshZid(refreshToken);
  }
}

async function refreshSalla(refreshToken: string): Promise<RefreshResult | null> {
  if (!config.SALLA_CLIENT_ID || !config.SALLA_CLIENT_SECRET) return null;
  const res = await fetch('https://accounts.salla.sa/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.SALLA_CLIENT_ID,
      client_secret: config.SALLA_CLIENT_SECRET,
    }),
  });
  if (!res.ok) return null;
  const t = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!t.access_token) return null;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? undefined,
    expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : undefined,
  };
}

async function refreshZid(refreshToken: string): Promise<RefreshResult | null> {
  if (!config.ZID_CLIENT_ID || !config.ZID_CLIENT_SECRET) return null;
  const redirectUri = `${config.APP_BASE_URL}/api/oauth/zid/callback`;
  const res = await fetch('https://oauth.zid.sa/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.ZID_CLIENT_ID,
      client_secret: config.ZID_CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) return null;
  const t = (await res.json()) as {
    access_token?: string;
    authorization?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!t.access_token || !t.authorization) return null;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? undefined,
    expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : undefined,
    metadata: { zidAuthorization: t.authorization },
  };
}