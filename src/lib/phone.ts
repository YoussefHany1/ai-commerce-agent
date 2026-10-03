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
 * CRITICAL: the suffix is part of the ADDRESS, not decoration. An account that WhatsApp
 * issued a LID for (`966501234567@lid`) does not also answer at
 * `966501234567@s.whatsapp.net`. Reducing to digits and rebuilding the phone-number
 * suffix yields a well-formed JID for the wrong identity: Baileys accepts the write,
 * `sendMessage` resolves, the automation is logged `sent`, and WhatsApp drops it. Nothing
 * errors and no reply ever arrives. So digits are kept for MATCHING while the exact JID
 * is kept for SENDING.
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
 * The canonical JID for a set of digits, plus whether it must stay a LID.
 *
 * `'@c.us'` is deliberately normalised to `'@s.whatsapp.net'`: both address an
 * individual by phone number and Baileys accepts the latter everywhere. `'@lid'` is
 * NOT interchangeable with it and is preserved verbatim.
 */
export type Addressable = { digits: string; jid: string };

/**
 * Reduce a JID to bare digits, keeping the exact address for sending.
 *
 * @returns the digits and the JID to send to, or `null` when the input is not a
 *          recognised individual JID.
 */
export function parseJid(input: string | null | undefined): Addressable | null {
  if (!input) return null;
  const raw = input.trim().toLowerCase();
  if (!raw) return null;

  const at = raw.lastIndexOf('@');
  if (at === -1) return null;

  const user = raw.slice(0, at);
  const server = raw.slice(at + 1);

  if (!USER_SUFFIXES.includes(`@${server}`)) return null;

  const digits = user.split(':')[0]!.replace(/\D/g, '');
  if (!digits) return null;

  const jid = server === 'lid' ? `${digits}@lid` : `${digits}@s.whatsapp.net`;
  return { digits, jid };
}

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
 * Build a JID for sending from bare digits.
 *
 * This assumes a phone-number identity and therefore yields `@s.whatsapp.net`. It is
 * only correct when the digits genuinely came from a phone-number JID. For a contact
 * WhatsApp addressed by LID, pass the stored JID straight to `sendMessage` instead —
 * going through here is what silently loses those messages.
 *
 * @returns `'966501234567@s.whatsapp.net'`, or `null` when the input is not digits.
 */
export function toJid(digits: string | null | undefined): string | null {
  if (!digits) return null;
  const raw = String(digits).trim().replace(/\D/g, '');
  if (!raw) return null;
  return `${raw}@s.whatsapp.net`;
}

/**
 * Normalise a user-entered phone number to the bare international digits that
 * Baileys' `requestPairingCode` expects.
 *
 * The value is handed straight to `jidEncode(..., 's.whatsapp.net')`, which does not
 * strip separators: `'+966 50 123 4567'` becomes `'+966 50 123 4567@s.whatsapp.net'`,
 * an invalid JID, and the code then never pairs. Only digits survive.
 *
 * This does NOT infer a country code. The merchant must enter the number in full
 * international format — country code first, a leading `+` being optional.
 *
 * @returns the digits, or `null` when the input contains none.
 */
export function pairingDigits(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, '');
  return digits || null;
}

/**
 * Resolve the address to send to, preferring a known JID over bare digits.
 *
 * @param jid   the exact JID captured on inbound, when one was stored.
 * @param digits fallback for rows written before JIDs were persisted, and for
 *               operators who typed a number by hand.
 */
export function addressForSend(jid: string | null | undefined, digits: string | null | undefined): string | null {
  if (jid) {
    const parsed = parseJid(jid);
    if (parsed) return parsed.jid;
  }
  return toJid(digits);
}