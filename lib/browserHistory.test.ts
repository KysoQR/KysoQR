import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./signedPdfStore', () => ({
  pruneSignedPdfs: vi.fn(async () => {}),
  clearAllStoredPdfs: vi.fn(async () => {}),
}));

import { cleanupBrowserStorage, clearBrowserHistory } from './browserHistory';
import { clearAllStoredPdfs, pruneSignedPdfs } from './signedPdfStore';
import { pendingCode } from './recentSignatures';

const fakeStorage = () => {
  const map = new Map<string, string>();
  return {
    map,
    api: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  };
};
let local: ReturnType<typeof fakeStorage>;
let session: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  vi.clearAllMocks();
  local = fakeStorage();
  session = fakeStorage();
  (globalThis as { window?: unknown }).window = { localStorage: local.api, sessionStorage: session.api };
});

const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
const DAY = 24 * 60 * 60 * 1000;

describe('cleanupBrowserStorage', () => {
  it('expires entries, keeps files only for what is left + the session on screen', async () => {
    local.map.set(
      'kysoqr.recentSignatures',
      JSON.stringify([
        { code: 'kysoqr.com#KEEP01', name: 'a.pdf', signedAt: iso(-DAY), status: 'signed' },
        { code: 'kysoqr.com#OLD001', name: 'b.pdf', signedAt: iso(-8 * DAY), status: 'signed' },
        { code: pendingCode('gone'), name: 'c.pdf', signedAt: iso(-60_000), status: 'pending', expiresAt: iso(-1000) },
      ])
    );
    session.map.set('kysoqr.activeSession', JSON.stringify({ kind: 'failed', code: pendingCode('x'), name: 'x.pdf' }));
    // An old version's round keys in localStorage.
    local.map.set('kysoqr.identityKey', 'leaked');
    local.map.set('kysoqr.signRequestId', 'req-old');

    await cleanupBrowserStorage();

    const list = JSON.parse(local.map.get('kysoqr.recentSignatures')!) as { code: string }[];
    expect(list.map((e) => e.code)).toEqual(['kysoqr.com#KEEP01']);
    expect(pruneSignedPdfs).toHaveBeenCalledWith(['kysoqr.com#KEEP01', pendingCode('x')]);
    expect(local.map.has('kysoqr.identityKey')).toBe(false);
    expect(local.map.has('kysoqr.signRequestId')).toBe(false);
  });
});

describe('clearBrowserHistory', () => {
  it('wipes the list, the tab session and every stored PDF', async () => {
    local.map.set('kysoqr.recentSignatures', '[]');
    session.map.set('kysoqr.signRequestId', 'req-1');
    session.map.set('kysoqr.activeSession', '{}');
    await clearBrowserHistory();
    expect(local.map.has('kysoqr.recentSignatures')).toBe(false);
    expect(session.map.size).toBe(0);
    expect(clearAllStoredPdfs).toHaveBeenCalled();
  });
});
