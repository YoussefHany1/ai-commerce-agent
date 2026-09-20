import { config } from '../config.js';
import { decryptKey } from '../lib/encryption.js';
import type { WhatsappChannel } from '../db/schema.js';
import { logger } from '../lib/logger.js';

export async function sendText(to: string, body: string, channel: WhatsappChannel): Promise<boolean> {
  const token = decryptChannelToken(channel);
  if (!token) return false;
  const url = `https://graph.facebook.com/${config.WHATSAPP_GRAPH_VERSION}/${channel.phoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body } }),
    });
    if (!res.ok) logger.warn({ to, status: res.status }, 'whatsapp send failed');
    return res.ok;
  } catch (err) {
    logger.warn({ err }, 'whatsapp send error');
    return false;
  }
}

export function decryptChannelToken(channel: WhatsappChannel): string | null {
  if (!channel.accessTokenEnc) return null;
  return channel.accessTokenEnc.startsWith('enc:') ? decryptKey(channel.accessTokenEnc) : channel.accessTokenEnc;
}