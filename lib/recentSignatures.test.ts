import { beforeEach, describe, expect, it } from 'vitest';
import {
  addRecentSignature,
  getRecentSignatures,
  pendingCode,
  removeRecentSignature,
  replaceRecentSignature,
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

const signed = (code: string): RecentSignature => ({
  code,
  name: `${code}.pdf`,
  signedAt: '2026-11-25T00:00:00Z',
  status: 'signed',
});

describe('recentSignatures', () => {
  it('reads entries saved before `status` existed (treated as signed)', () => {
    store.set(
      'kysoqr.recentSignatures',
      JSON.stringify([{ code: 'kysoqr.com#AAAAAA', name: 'a.pdf', signedAt: '2026-01-01T00:00:00Z' }])
    );
    const [entry] = getRecentSignatures();
    expect(entry?.code).toBe('kysoqr.com#AAAAAA');
    expect(entry?.status).toBeUndefined();
  });

  it('replaces a pending round in place once signed, without duplicates', () => {
    addRecentSignature(signed('kysoqr.com#OLD111'));
    const pending: RecentSignature = {
      code: pendingCode('req-1'),
      name: 'x.pdf',
      signedAt: '2026-11-25T00:00:00Z',
      status: 'pending',
      signRequestId: 'req-1',
      qrContent: 'https://example.test/qr',
    };
    addRecentSignature(pending);
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

  it('keeps a pending round\'s signature boxes', () => {
    const fields = [{ page: 2, xRatio: 0.5, yRatio: 0.4, widthRatio: 0.3, heightRatio: 0.1 }];
    addRecentSignature({
      code: pendingCode('req-2'),
      name: 'y.pdf',
      signedAt: '2026-11-25T00:00:00Z',
      status: 'pending',
      signRequestId: 'req-2',
      signatureFields: fields,
    });
    expect(getRecentSignatures()[0]?.signatureFields).toEqual(fields);
  });
});
