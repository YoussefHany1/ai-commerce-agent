import { encryptKey, decryptKey, isEncrypted } from '../lib/encryption.js';

export function encryptPii(plaintext: string): string {
  return encryptKey(plaintext);
}

export function decryptPii(value: string): string {
  return isEncrypted(value) ? decryptKey(value) : value;
}