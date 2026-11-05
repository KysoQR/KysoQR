import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Keys and primitives for the VNeID store. Everything derives from the one
 * store key (vneid.key, lib/vneid/localSecret.ts) through HKDF, so the
 * database alone reveals nothing:
 *   - K_hmac: HMAC of the CCCD (locks / limits per citizen without keeping
 *     the number) and of the client IP (audit);
 *   - K_enc: AES-256-GCM for what has to come back later (certificate chain,
 *     prepared PDF data), bound to the transaction and column through AAD so
 *     a ciphertext cannot be moved to another row or column.
 * Replacing the key makes in-flight transactions unreadable (they fail
 * closed) and nothing else: no long-lived data depends on it.
 */

export interface VneidKeys {
  hmac: Buffer;
  enc: Buffer;
}

const HKDF_SALT = Buffer.from('kysoqr-vneid-v1', 'utf8');
const SEAL_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function deriveKeys(secret: Buffer): VneidKeys {
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, info, 32));
  return { hmac: derive('hmac'), enc: derive('enc') };
}

export const sha256 = (data: Uint8Array | string): Buffer =>
  createHash('sha256').update(data).digest();

export const hmacSha256 = (key: Uint8Array, data: Uint8Array | string): Buffer =>
  createHmac('sha256', key).update(data).digest();

/** Lookup key for one citizen; the CCCD itself is never stored. */
export const citizenKey = (keys: VneidKeys, citizenPid: string): string =>
  hmacSha256(keys.hmac, `citizen:${citizenPid}`).toString('hex');

export const ipKey = (keys: VneidKeys, ip: string): string =>
  hmacSha256(keys.hmac, `ip:${ip}`).toString('hex');

/** 256-bit bearer secret handed to the browser (43 base64url characters). */
export const newClientSecret = (): string => randomBytes(32).toString('base64url');

export const hashClientSecret = (secret: string): Buffer => sha256(`client-secret:${secret}`);

/** Constant-time comparison; different lengths are simply unequal. */
export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** version (1) | iv (12) | tag (16) | ciphertext */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.of(SEAL_VERSION), iv, cipher.getAuthTag(), ciphertext]);
}

/** Throws when the data was altered, sealed under another AAD or another key. */
export function open(key: Uint8Array, sealed: Uint8Array, aad: string): Buffer {
  const data = Buffer.from(sealed);
  if (data.length < 1 + IV_BYTES + TAG_BYTES || data[0] !== SEAL_VERSION) {
    throw new Error('sealed value has an unknown format');
  }
  const iv = data.subarray(1, 1 + IV_BYTES);
  const tag = data.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(data.subarray(1 + IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]);
}
