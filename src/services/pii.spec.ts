import { describe, it, expect, afterAll, vi } from 'vitest';

const ORIG = {
  version: process.env.ENCRYPTION_KEY_VERSION,
  key: process.env.ENCRYPTION_KEY,
};

function setKey() {
  process.env.ENCRYPTION_KEY_VERSION = 'v1';
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
}

function restoreKey() {
  if (ORIG.version === undefined) delete process.env.ENCRYPTION_KEY_VERSION;
  else process.env.ENCRYPTION_KEY_VERSION = ORIG.version;
  if (ORIG.key === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIG.key;
}

describe('encryptPii', () => {
  afterAll(restoreKey);

  it('produces ciphertext distinct from plaintext', async () => {
    setKey();
    vi.resetModules();
    const { encryptPii } = await import('./pii.js');
    const enc = encryptPii('الدفع عند الاستلام');
    expect(enc).not.toContain('الدفع');
    expect(enc.startsWith('enc:v1:')).toBe(true);
  });

  it('round-trips through decryptPii', async () => {
    setKey();
    vi.resetModules();
    const { encryptPii, decryptPii } = await import('./pii.js');
    const cipher = encryptPii('رقم الجوال 966500000001');
    expect(decryptPii(cipher)).toBe('رقم الجوال 966500000001');
  });

  it('decryptPii passes through legacy plaintext untouched', async () => {
    setKey();
    vi.resetModules();
    const { decryptPii } = await import('./pii.js');
    expect(decryptPii('hello plaintext')).toBe('hello plaintext');
    expect(decryptPii('')).toBe('');
  });
});