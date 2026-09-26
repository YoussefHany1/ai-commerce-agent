import { describe, expect, it } from 'vitest';
import {
  hashOperatorPassword,
  isOperatorHashFormat,
  verifyOperatorPassword,
  MIN_OPERATOR_PASSWORD_LENGTH,
} from './passwordHash.js';

const PASSWORD = 'correct horse battery staple';

describe('isOperatorHashFormat', () => {
  it('rejects absent and empty values', () => {
    expect(isOperatorHashFormat(undefined)).toBe(false);
    expect(isOperatorHashFormat('')).toBe(false);
  });

  it('rejects a plaintext password so a misconfigured env fails loudly', () => {
    expect(isOperatorHashFormat(PASSWORD)).toBe(false);
    expect(isOperatorHashFormat('scrypt$16384$8$1$deadbeef')).toBe(false);
    expect(isOperatorHashFormat('bcrypt$16384$8$1$deadbeef$abcdef')).toBe(false);
  });

  it('rejects wrong salt or digest widths', () => {
    expect(isOperatorHashFormat('scrypt$16384$8$1$deadbeef$abcdef')).toBe(false);
    expect(isOperatorHashFormat(`scrypt$16384$8$1$${'a'.repeat(128)}`)).toBe(false);
    expect(isOperatorHashFormat(`scrypt$16384$8$1$${'a'.repeat(32)}${'a'.repeat(126)}`)).toBe(false);
  });

  it('rejects non-hex characters', () => {
    const salt = 'z'.repeat(32);
    expect(isOperatorHashFormat(`scrypt$16384$8$1$${salt}${'a'.repeat(128)}`)).toBe(false);
  });

  it('rejects a non-power-of-two or absurd cost', () => {
    const salt = 'a'.repeat(32);
    const hash = 'a'.repeat(128);
    expect(isOperatorHashFormat(`scrypt$16385$8$1$${salt}$${hash}`)).toBe(false);
    expect(isOperatorHashFormat(`scrypt$4194304$8$1$${salt}$${hash}`)).toBe(false);
    expect(isOperatorHashFormat(`scrypt$1048576$8$1$${salt}$${hash}`)).toBe(true);
  });

  it('accepts a hash produced by hashOperatorPassword', async () => {
    expect(isOperatorHashFormat(await hashOperatorPassword(PASSWORD))).toBe(true);
  });
});

describe('hashOperatorPassword / verifyOperatorPassword', () => {
  it('round-trips the correct password', async () => {
    const stored = await hashOperatorPassword(PASSWORD);
    await expect(verifyOperatorPassword(PASSWORD, stored)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashOperatorPassword(PASSWORD);
    await expect(verifyOperatorPassword(`${PASSWORD}x`, stored)).resolves.toBe(false);
    await expect(verifyOperatorPassword('', stored)).resolves.toBe(false);
  });

  it('salts each hash so identical passwords differ', async () => {
    const [a, b] = await Promise.all([hashOperatorPassword(PASSWORD), hashOperatorPassword(PASSWORD)]);
    expect(a).not.toBe(b);
    await expect(verifyOperatorPassword(PASSWORD, a)).resolves.toBe(true);
    await expect(verifyOperatorPassword(PASSWORD, b)).resolves.toBe(true);
  });

  it('enforces a minimum length when hashing', async () => {
    await expect(hashOperatorPassword('a'.repeat(MIN_OPERATOR_PASSWORD_LENGTH - 1))).rejects.toThrow(
      /at least/,
    );
  });

  it('refuses to verify against a malformed stored value instead of throwing', async () => {
    await expect(verifyOperatorPassword(PASSWORD, 'not-a-hash')).resolves.toBe(false);
    await expect(verifyOperatorPassword(PASSWORD, `scrypt$x$8$1$${'a'.repeat(32)}${'a'.repeat(128)}`)).resolves.toBe(
      false,
    );
  });

  it('rejects an oversized candidate without spending scrypt work on it', async () => {
    const stored = await hashOperatorPassword(PASSWORD);
    await expect(verifyOperatorPassword('a'.repeat(5000), stored)).resolves.toBe(false);
  });
});
