import forge from 'node-forge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getCachedAiaCerts,
  getStaleAiaCerts,
  resetAiaCertCacheForTests,
  setCachedAiaCerts,
} from './aiaCertCache';

function fakeCert(commonName: string): forge.pki.Certificate {
  const keys = forge.pki.rsa.generateKeyPair(512); // tiny key -- these tests never verify signatures
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date('2024-01-01T00:00:00Z');
  cert.validity.notAfter = new Date('2030-01-01T00:00:00Z');
  cert.setSubject([{ name: 'commonName', value: commonName }]);
  cert.setIssuer([{ name: 'commonName', value: commonName }]);
  cert.sign(keys.privateKey, forge.md.sha1.create());
  return cert;
}

afterEach(() => {
  resetAiaCertCacheForTests();
  vi.useRealTimers();
});

describe('aiaCertCache', () => {
  it('returns null for a URL that was never cached', () => {
    expect(getCachedAiaCerts('https://example.test/never-set.cer')).toBeNull();
  });

  it('returns exactly what was cached for that URL', () => {
    const cert = fakeCert('Test Intermediate');
    setCachedAiaCerts('https://example.test/cached.cer', [cert]);
    const result = getCachedAiaCerts('https://example.test/cached.cer');
    expect(result).toHaveLength(1);
    expect(forge.pki.certificateToPem(result![0]!)).toBe(forge.pki.certificateToPem(cert));
  });

  it('does not leak between different URLs', () => {
    setCachedAiaCerts('https://a.test/x.cer', [fakeCert('A')]);
    expect(getCachedAiaCerts('https://b.test/y.cer')).toBeNull();
  });

  it('never caches an empty result', () => {
    setCachedAiaCerts('https://example.test/empty.cer', []);
    expect(getCachedAiaCerts('https://example.test/empty.cer')).toBeNull();
  });

  it('expires an entry after 24h but keeps it as a stale fallback until refreshed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    setCachedAiaCerts('https://example.test/ttl.cer', [fakeCert('TTL Test')]);
    expect(getCachedAiaCerts('https://example.test/ttl.cer')).toHaveLength(1);

    vi.setSystemTime(new Date('2026-01-01T23:59:00Z')); // 23h59 later -- still within the 24h TTL
    expect(getCachedAiaCerts('https://example.test/ttl.cer')).toHaveLength(1);

    vi.setSystemTime(new Date('2026-01-02T00:01:00Z')); // past the 24h TTL
    expect(getCachedAiaCerts('https://example.test/ttl.cer')).toBeNull();
    // ...but the expired copy is still there for when a fresh fetch fails
    expect(getStaleAiaCerts('https://example.test/ttl.cer')).toHaveLength(1);

    setCachedAiaCerts('https://example.test/ttl.cer', [fakeCert('TTL Test')]); // refreshed
    expect(getCachedAiaCerts('https://example.test/ttl.cer')).toHaveLength(1);
  });

  it('has no stale fallback for a URL that was never cached', () => {
    expect(getStaleAiaCerts('https://example.test/never-set.cer')).toBeNull();
  });

  it('evicts the oldest entry once the cache is full, bounding memory without a background sweep', () => {
    // MAX_CACHE_ENTRIES is 200 -- fill past it and confirm the very first
    // entry inserted is gone while a recent one survives.
    for (let i = 0; i < 205; i += 1) {
      setCachedAiaCerts(`https://example.test/${i}.cer`, [fakeCert(`Cert ${i}`)]);
    }
    expect(getCachedAiaCerts('https://example.test/0.cer')).toBeNull();
    expect(getCachedAiaCerts('https://example.test/204.cer')).toHaveLength(1);
  });
});
