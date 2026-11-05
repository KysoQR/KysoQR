import { describe, expect, it } from 'vitest';
import {
  citizenKey,
  deriveKeys,
  hashClientSecret,
  newClientSecret,
  open,
  safeEqual,
  seal,
} from './crypto';

const keys = deriveKeys(Buffer.alloc(32, 1));

describe('VNeID crypto helpers', () => {
  it('derives stable, distinct keys from the secret', () => {
    expect(deriveKeys(Buffer.alloc(32, 1))).toEqual(keys);
    expect(keys.hmac.equals(keys.enc)).toBe(false);
    expect(deriveKeys(Buffer.alloc(32, 2)).hmac.equals(keys.hmac)).toBe(false);
  });

  it('keys a citizen without keeping the number', () => {
    const key = citizenKey(keys, '012345678901');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('012345678901');
    expect(citizenKey(keys, '012345678901')).toBe(key);
    expect(citizenKey(keys, '012345678902')).not.toBe(key);
  });

  it('hands out 256-bit url-safe client secrets', () => {
    const secret = newClientSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newClientSecret()).not.toBe(secret);
    expect(safeEqual(hashClientSecret(secret), hashClientSecret(secret))).toBe(true);
    expect(safeEqual(hashClientSecret(secret), hashClientSecret(newClientSecret()))).toBe(false);
    expect(safeEqual(Buffer.alloc(3), Buffer.alloc(4))).toBe(false);
  });

  it('seals and opens, bound to its AAD', () => {
    const sealed = seal(keys.enc, Buffer.from('chain'), 'tx-1:cert_chain');
    expect(open(keys.enc, sealed, 'tx-1:cert_chain').toString()).toBe('chain');
    expect(() => open(keys.enc, sealed, 'tx-2:cert_chain')).toThrow();
    expect(() => open(keys.enc, sealed, 'tx-1:prepared')).toThrow();
    expect(() => open(deriveKeys(Buffer.alloc(32, 3)).enc, sealed, 'tx-1:cert_chain')).toThrow();
  });

  it('refuses a ciphertext with any byte changed', () => {
    const sealed = seal(keys.enc, Buffer.from('prepared data'), 'aad');
    for (const index of [0, 5, 20, sealed.length - 1]) {
      const altered = Buffer.from(sealed);
      altered[index]! ^= 0x01;
      expect(() => open(keys.enc, altered, 'aad')).toThrow();
    }
    expect(() => open(keys.enc, sealed.subarray(0, 10), 'aad')).toThrow();
  });
});
