/**
 * WhatsApp JID handling for the Baileys (WhatsApp Web) transport.
 *
 * A JID is WhatsApp's internal address format and reaches us in several shapes that
 * all denote the same person:
 *
 *   '966501234567@s.whatsapp.net'  individual chats
 *   '966501234567@c.us'             the older individual-chat suffix
 *   '966501234567@lid'              linked-device identity — Baileys uses this for
 *                                    some contacts in multi-device accounts
 *   '966501234567:12@s.whatsapp.net' the ':12' is a device id
 *
 * Two rules follow, and both are load-bearing:
 *
 *   1. Everything downstream stores bare digits. `customerRepo.upsert({ phone })`,
 *      order-sync attribution matching and the dashboard all compare phone numbers as
 *      strings. Persisting a JID anywhere it is compared against an order phone number
 *      loses the match silently — the comparison fails, not throws, so the attribution
 *      simply never converts.
 *   2. `normalizeJid` returns `null` rather than a best-effort string for anything it
 *      does not recognise. An empty or partially-parsed value would be written to the
 *      customers table as if it were a real phone number.
 */

/** WhatsApp suffixes that all address an individual user. */
const USER_SUFFIXES = ['@s.whatsapp.net', '@c.us', '@lid'];

/**
 * Reduce a JID to bare digits.
 *
 * @returns the digits, or `null` when the input is not a recognised individual JID.
 */
export function normalizeJid(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  const at = raw.lastIndexOf('@');
  if (at === -1) return null;

  const user = raw.slice(0, at);
  const server = raw.slice(at + 1);

  // Group JIDs ('123-456@g.us') and broadcasts ('123@broadcast') are not people we
  // can hold a conversation record for.
  if (!USER_SUFFIXES.includes(`@${server}`)) return null;

  // Strip the device suffix, then keep digits only.
  const digits = user.split(':')[0]!.replace(/\D/g, '');
  if (!digits) return null;

  return digits;
}

/**
 * Build a JID for sending.
 *
 * @returns `'966501234567@s.whatsapp.net'`, or `null` when the input is not digits.
 */
export function toJid(digits: string | null | undefined): string | null {
  if (!digits) return null;
  const raw = String(digits).trim().replace(/\D/g, '');
  if (!raw) return null;
  return `${raw}@s.whatsapp.net`;
}