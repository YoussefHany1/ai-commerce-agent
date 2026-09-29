import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PREFIX = 'scrypt';
const PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEYLEN = 64;
const SALT_BYTES = 16;
const MAX_N = 1 << 20;

export const MIN_PASSWORD_LENGTH = 12;
/** The operator constants are kept as aliases for existing call sites and scripts. */
export const MIN_OPERATOR_PASSWORD_LENGTH = MIN_PASSWORD_LENGTH;
export const MAX_PASSWORD_LENGTH = 1024;
export const MAX_OPERATOR_PASSWORD_LENGTH = MAX_PASSWORD_LENGTH;

/**
 * Encoded form: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`.
 *
 * Parameters are stored alongside the digest so a hash stays verifiable after
 * the cost factors are raised, and the strict shape check lets `loadConfig`
 * reject a plaintext password pasted into the environment at boot instead of
 * silently never matching.
 */
export function isOperatorHashFormat(value: string | undefined): boolean {
  if (!value) return false;
  const parts = value.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  if (!/^\d+$/.test(n) || !/^\d+$/.test(r) || !/^\d+$/.test(p)) return false;
  const nNum = Number(n);
  // N must be a power of two, and capped so a tampered value cannot be used
  // to turn a login attempt into a memory-exhaustion vector.
  if (nNum < 2 || nNum > MAX_N || (nNum & (nNum - 1)) !== 0) return false;
  if (Number(r) < 1 || Number(p) < 1) return false;
  if (salt.length !== SALT_BYTES * 2 || hash.length !== KEYLEN * 2) return false;
  return /^[0-9a-f]+$/.test(salt) && /^[0-9a-f]+$/.test(hash);
}

export async function hashOperatorPassword(password: string): Promise<string> {
  if (password.length < MIN_OPERATOR_PASSWORD_LENGTH) {
    throw new Error(`operator password must be at least ${MIN_OPERATOR_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_OPERATOR_PASSWORD_LENGTH) {
    throw new Error(`operator password must be at most ${MAX_OPERATOR_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, PARAMS);
  return [PREFIX, PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('hex'), key.toString('hex')].join('$');
}

/**
 * The same scrypt format, under a name that does not claim to be operator-only.
 *
 * `clients.password_hash` stores the identical encoding, so there is exactly one
 * hasher and one verifier for every password in the system; the "operator" names
 * are kept because `operatorAuth.ts`, the config boot checks and the provisioning
 * scripts already import them.
 */
export function hashPassword(password: string): Promise<string> {
  return hashOperatorPassword(password);
}

export async function verifyOperatorPassword(password: string, stored: string): Promise<boolean> {
  if (!isOperatorHashFormat(stored)) return false;
  if (password.length > MAX_OPERATOR_PASSWORD_LENGTH) return false;
  const [, n, r, p, saltHex, hashHex] = stored.split('$') as [string, string, string, string, string, string];
  const expected = Buffer.from(hashHex, 'hex');
  let actual: Buffer;
  try {
    actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: PARAMS.maxmem,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyPassword(password: string, stored: string): Promise<boolean> {
  return verifyOperatorPassword(password, stored);
}
