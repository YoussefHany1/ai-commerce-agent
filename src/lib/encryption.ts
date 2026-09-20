import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';

export function encryptKey(plaintext: string, version: string = config.encryption.version): string {
  const key = config.encryption.keys[version];
  if (!key) throw new Error(`no encryption key for version ${version}`);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, Buffer.from(key, 'hex'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${version}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptKey(value: string): string {
  const [marker, , version, ivB64, tagB64, ctB64] = value.split(':');
  if (marker !== 'enc' || !ivB64 || !tagB64 || !ctB64) throw new Error('malformed encrypted value');
  const key = config.encryption.keys[version];
  if (!key) throw new Error(`no encryption key for version ${version}`);
  const decipher = createDecipheriv(ALGO, Buffer.from(key, 'hex'), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export function keyVersionOf(value: string): string {
  const parts = value.split(':');
  return parts[2] ?? config.encryption.version;
}

export function isEncrypted(value: string): boolean {
  return value.startsWith('enc:v1:');
}