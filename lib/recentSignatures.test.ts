import { beforeEach, describe, expect, it } from 'vitest';
import {
  RECENT_TTL_MS,
  addRecentSignature,
  cleanupRecentSignatures,
  forgetIdentityKey,
  getRecentSignatures,
  pendingCode,
  removeRecentSignature,
  replaceRecentSignature,
  updateRecentSignature,
  type RecentSignature,
} from './recentSignatures';

// Minimal in-memory localStorage on a fake `window` (tests run in node).
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };
});

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const MINUTE = 60 * 1000;
const saved = () => JSON.parse(store.get('kysoqr.recentSignatures') ?? '[]') as RecentSignature[];

const signed = (code: string, extra: Partial<RecentSignature> = {}): RecentSignature => ({
  code,
  name: `${code}.pdf`,
  signedAt: iso(-5 * MINUTE),
  status: 'signed',
  ...extra,
});
const pending = (id: string, extra: Partial<RecentSignature> = {}): RecentSignature => ({
  code: pendingCode(id),
  name: `${id}.pdf`,
  signedAt: iso(-60_000),
  status: 'pending',
  signRequestId: id,
  ...extra,
});

describe('recentSignatures', () => {
  it('reads entries saved before `status` existed (treated as signed)', () => {
    store.set(
      'kysoqr.recentSignatures',
      JSON.stringify([{ code: 'kysoqr.com#AAAAAA', name: 'a.pdf', signedAt: iso(-5 * MINUTE) }])
    );
    const [entry] = getRecentSignatures();
    expect(entry?.code).toBe('kysoqr.com#AAAAAA');
    expect(entry?.status).toBeUndefined();
  });

  it('replaces a pending round in place once signed, without duplicates', () => {
    addRecentSignature(signed('kysoqr.com#OLD111'));
    addRecentSignature(pending('req-1', { qrContent: 'https://example.test/qr' }));
    replaceRecentSignature(pendingCode('req-1'), signed('kysoqr.com#NEW222'));
    expect(getRecentSignatures().map((e) => e.code)).toEqual(['kysoqr.com#NEW222', 'kysoqr.com#OLD111']);
  });

  it('replace falls back to add when the pending entry is gone', () => {
    replaceRecentSignature(pendingCode('missing'), signed('kysoqr.com#NEW333'));
    expect(getRecentSignatures().map((e) => e.code)).toEqual(['kysoqr.com#NEW333']);
  });

  it('removes one entry', () => {
    addRecentSignature(signed('kysoqr.com#A11111'));
    addRecentSignature(signed('kysoqr.com#B22222'));
    removeRecentSignature('kysoqr.com#A11111');
    expect(getRecentSignatures().map((e) => e.code)).toEqual(['kysoqr.com#B22222']);
  });

  it("keeps a pending round's signature boxes", () => {
    const fields = [{ page: 2, xRatio: 0.5, yRatio: 0.4, widthRatio: 0.3, heightRatio: 0.1 }];
    addRecentSignature(pending('req-2', { signatureFields: fields }));
    expect(getRecentSignatures()[0]?.signatureFields).toEqual(fields);
  });

  it('hides entries past the 30-minute TTL, and cleanup drops them from storage', () => {
    store.set(
      'kysoqr.recentSignatures',
      JSON.stringify([
        signed('kysoqr.com#NEW000'),
        signed('kysoqr.com#OLD000', { signedAt: iso(-RECENT_TTL_MS - MINUTE) }),
      ])
    );
    expect(getRecentSignatures().map((e) => e.code)).toEqual(['kysoqr.com#NEW000']);
    expect(saved()).toHaveLength(2);
    cleanupRecentSignatures();
    expect(saved().map((e) => e.code)).toEqual(['kysoqr.com#NEW000']);
  });

  it('keeps an entry 29 minutes old, drops one 31 minutes old', () => {
    store.set(
      'kysoqr.recentSignatures',
      JSON.stringify([
        signed('kysoqr.com#MIN029', { signedAt: iso(-29 * MINUTE) }),
        signed('kysoqr.com#MIN031', { signedAt: iso(-31 * MINUTE) }),
      ])
    );
    expect(getRecentSignatures().map((e) => e.code)).toEqual(['kysoqr.com#MIN029']);
  });

  it('drops a pending round once its QR has expired, even within 30 minutes', () => {
    addRecentSignature(pending('expired', { expiresAt: iso(-1000) }));
    addRecentSignature(pending('no-expiry-yet'));
    addRecentSignature(pending('live', { expiresAt: iso(5 * MINUTE) }));
    expect(getRecentSignatures().map((e) => e.code)).toEqual([pendingCode('live'), pendingCode('no-expiry-yet')]);
  });

  it('drops an expired identityKey but keeps the entry', () => {
    addRecentSignature(signed('kysoqr.com#KEY000', { identityKey: 'ik', identityKeyExpiresAt: iso(-1000) }));
    const [entry] = getRecentSignatures();
    expect(entry?.code).toBe('kysoqr.com#KEY000');
    expect(entry?.identityKey).toBeUndefined();
  });

  it('forgetIdentityKey removes the key once the PDF is kept locally', () => {
    addRecentSignature(signed('kysoqr.com#KEY111', { identityKey: 'ik', identityKeyExpiresAt: iso(60 * MINUTE) }));
    forgetIdentityKey('kysoqr.com#KEY111');
    expect(saved()[0]?.identityKey).toBeUndefined();
    expect(saved()[0]?.identityKeyExpiresAt).toBeUndefined();
  });

  it('updateRecentSignature merges a patch (e.g. a pending expiry)', () => {
    addRecentSignature(pending('req-3'));
    const expiresAt = iso(5 * 60_000);
    updateRecentSignature(pendingCode('req-3'), { expiresAt });
    expect(saved()[0]?.expiresAt).toBe(expiresAt);
    expect(saved()[0]?.code).toBe(pendingCode('req-3'));
  });
});
