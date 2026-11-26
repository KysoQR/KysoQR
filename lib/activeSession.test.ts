import { beforeEach, describe, expect, it } from 'vitest';
import { clearActiveSession, getActiveSession, setActiveSession } from './activeSession';

// In-memory sessionStorage on a fake `window` (tests run in node).
const session = new Map<string, string>();
beforeEach(() => {
  session.clear();
  (globalThis as { window?: unknown }).window = {
    sessionStorage: {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, v),
      removeItem: (k: string) => void session.delete(k),
    },
  };
});

const KEY = 'kysoqr.activeSession';
const MINUTE = 60 * 1000;
const stored = (savedAt?: string) =>
  session.set(KEY, JSON.stringify({ kind: 'signed', code: 'kysoqr.com#ABC123', name: 'a.pdf', savedAt }));

describe('activeSession', () => {
  it('set stamps savedAt; a fresh session reads back', () => {
    setActiveSession({ kind: 'signed', code: 'kysoqr.com#ABC123', name: 'a.pdf' });
    expect(JSON.parse(session.get(KEY)!).savedAt).toEqual(expect.any(String));
    expect(getActiveSession()).toMatchObject({ kind: 'signed', code: 'kysoqr.com#ABC123', name: 'a.pdf' });
  });

  it('still valid at 29 minutes', () => {
    stored(new Date(Date.now() - 29 * MINUTE).toISOString());
    expect(getActiveSession()?.code).toBe('kysoqr.com#ABC123');
  });

  it('past 30 minutes: null, and cleared from storage', () => {
    stored(new Date(Date.now() - 31 * MINUTE).toISOString());
    expect(getActiveSession()).toBeNull();
    expect(session.has(KEY)).toBe(false);
  });

  it('saved by an older version (no savedAt): treated as expired', () => {
    stored(undefined);
    expect(getActiveSession()).toBeNull();
    expect(session.has(KEY)).toBe(false);
  });

  it('clear removes it', () => {
    setActiveSession({ kind: 'failed', code: 'pending:req', name: 'b.pdf', status: 'REJECTED' });
    clearActiveSession();
    expect(getActiveSession()).toBeNull();
  });
});
