import type { SignatureFieldProps } from './domain/SignatureField';

const STORAGE_KEY = 'kysoqr.recentSignatures';
const MAX_ENTRIES = 5;

export interface RecentSignature {
  /** orgIdSigned, e.g. "kysoqr.com#8F2K-4T7Q" -- used for the signing-round
   * lookup popup. A round still waiting for the signer has no orgIdSigned
   * yet, so it uses `pendingCode(signRequestId)` until it is signed. */
  code: string;
  /** Missing on entries saved before pending rounds were listed = signed. */
  status?: 'pending' | 'signed';
  /** Pending rounds only: what's needed to resume waiting on it. */
  signRequestId?: string;
  qrContent?: string;
  /** Pending rounds only: the boxes that were sent, so a reload (or
   * reopening it from the home page) still shows where it will be signed. */
  signatureFields?: SignatureFieldProps[];
  /** Document name at signing time, for display in the list. */
  name: string;
  /** ISO timestamp, for display/sort. */
  signedAt: string;
  /** CAS's ~5-use, ~1-day download token -- undefined once we know it's unusable
   * (kept simple: caller only omits it, we never separately track "spent"). */
  identityKey?: string;
  identityKeyExpiresAt?: string;
}

/** List/storage key for a round still waiting for the signer. */
export function pendingCode(signRequestId: string): string {
  return `pending:${signRequestId}`;
}

export function isPendingSignature(entry: RecentSignature): boolean {
  return entry.status === 'pending';
}

function isRecentSignature(value: unknown): value is RecentSignature {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.name === 'string' && typeof v.signedAt === 'string';
}

/** Reads the saved list, most-recent-first. Never throws -- malformed/missing
 * localStorage data (or SSR, where `window` doesn't exist) just yields `[]`. */
export function getRecentSignatures(): RecentSignature[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentSignature);
  } catch {
    return [];
  }
}

/** Adds a newly-signed session to the front of the list (position #1),
 * replacing any existing entry for the same `code` (re-signing the same
 * document moves it back to the front instead of duplicating it), then caps
 * the list at MAX_ENTRIES -- the oldest entry (previously in last place)
 * falls off once a 6th is added. Never throws. */
export function addRecentSignature(entry: RecentSignature): void {
  if (typeof window === 'undefined') return;
  try {
    const current = getRecentSignatures().filter((existing) => existing.code !== entry.code);
    const next = [entry, ...current].slice(0, MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // localStorage unavailable/full/disabled -- non-critical, just skip persisting.
  }
}

function writeList(list: RecentSignature[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_ENTRIES)));
  } catch {
    // localStorage unavailable/full/disabled -- non-critical.
  }
}

/** Drops one entry (e.g. a pending round that was rejected/expired or
 * abandoned). Never throws. */
export function removeRecentSignature(code: string): void {
  if (typeof window === 'undefined') return;
  writeList(getRecentSignatures().filter((existing) => existing.code !== code));
}

/** Replaces `oldCode`'s entry in place (a pending round that just got
 * signed keeps its position instead of showing twice); if it's gone,
 * behaves like `addRecentSignature`. Never throws. */
export function replaceRecentSignature(oldCode: string, entry: RecentSignature): void {
  if (typeof window === 'undefined') return;
  const current = getRecentSignatures();
  const index = current.findIndex((existing) => existing.code === oldCode);
  if (index === -1) {
    addRecentSignature(entry);
    return;
  }
  const next = current
    .map((existing, i) => (i === index ? entry : existing))
    .filter((existing, i) => i === index || existing.code !== entry.code);
  writeList(next);
}
