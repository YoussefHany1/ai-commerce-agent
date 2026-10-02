import { describe, expect, test } from 'vitest';
import { normalizeJid, toJid, parseJid, addressForSend } from '../lib/phone.js';

/**
 * These helpers sit on the boundary between WhatsApp's address format and the bare
 * digit strings the rest of the system compares against. A failure here does not
 * throw — it writes a JID into `customers.phone`, or matches no order in
 * `markConversationsForOrder` — so the cases below cover the spellings rather than
 * just the happy path.
 */
describe('normalizeJid', () => {
  test('handles the individual-chat suffix', () => {
    expect(normalizeJid('966501234567@s.whatsapp.net')).toBe('966501234567');
  });

  test('handles the legacy @c.us suffix', () => {
    expect(normalizeJid('966501234567@c.us')).toBe('966501234567');
  });

  test('handles @lid, which Baileys uses in multi-device accounts', () => {
    expect(normalizeJid('966501234567@lid')).toBe('966501234567');
  });

  test('strips the device suffix', () => {
    expect(normalizeJid('966501234567:12@s.whatsapp.net')).toBe('966501234567');
  });

  test('lowercases and trims, since these arrive from a socket payload', () => {
    expect(normalizeJid('  966501234567@S.WhatsApp.Net  ')).toBe('966501234567');
  });

  test('drops non-digits a pasted number may carry', () => {
    expect(normalizeJid('+966 50 123 4567@s.whatsapp.net')).toBe('966501234567');
  });

  test('rejects group JIDs: not a person we hold a conversation for', () => {
    expect(normalizeJid('123-456@g.us')).toBeNull();
  });

  test('rejects broadcast JIDs', () => {
    expect(normalizeJid('1234567@broadcast')).toBeNull();
  });

  test('rejects a status broadcast', () => {
    expect(normalizeJid('status@broadcast')).toBeNull();
  });

  test('rejects an unknown server rather than guessing', () => {
    expect(normalizeJid('966501234567@example.com')).toBeNull();
  });

  test('rejects input with no @ at all', () => {
    expect(normalizeJid('966501234567')).toBeNull();
  });

  test('reduces a LID to digits, which is a matching key and not a sendable address', () => {
    // The regression that made keyword replies vanish: the rule fired, `sendMessage`
    // resolved, `sent` was logged, and nothing arrived — because the digits were
    // rebuilt as a phone-number JID the contact does not answer on.
    expect(normalizeJid('51848895557795@lid')).toBe('51848895557795');
  });

  test('rejects a non-numeric user, which must not become an empty phone', () => {
    expect(normalizeJid('abcdef@s.whatsapp.net')).toBeNull();
  });

  test('rejects empty and nullish input', () => {
    expect(normalizeJid('')).toBeNull();
    expect(normalizeJid('   ')).toBeNull();
    expect(normalizeJid(null)).toBeNull();
    expect(normalizeJid(undefined)).toBeNull();
  });

  test('rejects a JID whose user part is only a device suffix', () => {
    expect(normalizeJid(':12@s.whatsapp.net')).toBeNull();
  });
});

describe('toJid', () => {
  test('appends the individual-chat suffix', () => {
    expect(toJid('966501234567')).toBe('966501234567@s.whatsapp.net');
  });

  test('round-trips a normalised inbound JID', () => {
    const inbound = '966501234567:12@s.whatsapp.net';
    expect(toJid(normalizeJid(inbound))).toBe('966501234567@s.whatsapp.net');
  });

  test('is idempotent on a JID it is already given', () => {
    expect(toJid('966501234567@s.whatsapp.net')).toBe('966501234567@s.whatsapp.net');
  });

  test('accepts a human-formatted number', () => {
    expect(toJid('+966 50 123 4567')).toBe('966501234567@s.whatsapp.net');
  });

  test('rejects empty and nullish input rather than sending to @s.whatsapp.net', () => {
    expect(toJid('')).toBeNull();
    expect(toJid('   ')).toBeNull();
    expect(toJid(null)).toBeNull();
    expect(toJid(undefined)).toBeNull();
  });

  test('rejects input with no digits at all', () => {
    expect(toJid('not-a-number')).toBeNull();
  });
});

describe('parseJid', () => {
  test('keeps a LID as a LID so the reply reaches the same identity', () => {
    expect(parseJid('51848895557795@lid')).toEqual({
      digits: '51848895557795',
      jid: '51848895557795@lid',
    });
  });

  test('normalises the legacy c.us suffix to s.whatsapp.net', () => {
    expect(parseJid('966501234567@c.us')?.jid).toBe('966501234567@s.whatsapp.net');
  });

  test('strips a device suffix', () => {
    expect(parseJid('966501234567:12@s.whatsapp.net')?.jid).toBe('966501234567@s.whatsapp.net');
  });

  test('rejects group and broadcast JIDs', () => {
    expect(parseJid('123-456@g.us')).toBeNull();
    expect(parseJid('1234567@broadcast')).toBeNull();
  });
});

describe('addressForSend', () => {
  test('sends a LID contact back to its LID, not to a phone-number JID', () => {
    // The bug: both reduce to the same digits, and replying to the phone-number form
    // of a LID-only contact is silently dropped by WhatsApp after a successful write.
    expect(addressForSend('51848895557795@lid', '51848895557795')).toBe('51848895557795@lid');
  });

  test('prefers the known JID over the digits', () => {
    expect(addressForSend('966501234567@s.whatsapp.net', '966501234567')).toBe('966501234567@s.whatsapp.net');
  });

  test('falls back to digits for contacts with no remembered JID', () => {
    expect(addressForSend(null, '966501234567')).toBe('966501234567@s.whatsapp.net');
  });

  test('ignores an unusable stored JID rather than sending nowhere', () => {
    expect(addressForSend('garbage', '966501234567')).toBe('966501234567@s.whatsapp.net');
  });

  test('returns null when there is nothing sendable', () => {
    expect(addressForSend(null, null)).toBeNull();
    expect(addressForSend('', '')).toBeNull();
  });
});