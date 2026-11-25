import type { SignatureFieldProps } from './domain/SignatureField';

export const RECENT_SIGNATURES_KEY = 'kysoqr.recentSignatures';
const STORAGE_KEY = RECENT_SIGNATURES_KEY;
const MAX_ENTRIES = 5;

/** Entries (and their locally kept PDFs) are dropped after 7 days -- signed
 * documents shouldn't sit in a browser forever, e.g. on a shared computer. */
export const RECENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A pending entry whose QR expiry was never recorded is dropped after this. */
const PENDING_FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

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
  /** Pending rounds only: when the QR/request expires (from the first status
   * poll) -- past it, the "Đang chờ ký" chip is dropped automatically. */
  expiresAt?: string;
  /** Document name at signing time, for display in the list. */
  name: string;
  /** ISO timestamp, for display/sort. */
  signedAt: string;
  /** CAS's ~5-use, ~1-day download token. Only kept until the signed PDF is
   * stored locally (`forgetIdentityKey`) or it expires -- it is a bearer
   * credential for the signed file, so it shouldn't linger in storage. */
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

const time = (iso: string | undefined): number => (iso ? new Date(iso).getTime() : NaN);

/** Past the 7-day TTL (by `signedAt`), or -- pending only -- past its QR
 * expiry (or 24h without one recorded). */
export function isRecentSignatureExpired(entry: RecentSignature, now = Date.now()): boolean {
  const signedAt = time(entry.signedAt);
  if (!Number.isFinite(signedAt) || now - signedAt > RECENT_TTL_MS) return true;
  if (!isPendingSignature(entry)) return false;
  const expiresAt = time(entry.expiresAt);
  if (Number.isFinite(expiresAt)) return now > expiresAt;
  return now - signedAt > PENDING_FALLBACK_TTL_MS;
}

function withoutIdentityKey(entry: RecentSignature): RecentSignature {
  const copy = { ...entry };
  delete copy.identityKey;
  delete copy.identityKeyExpiresAt;
  return copy;
}

/** The entry without an identityKey that is already past its expiry. */
function withoutExpiredKey(entry: RecentSignature, now: number): RecentSignature {
  const keyExpiry = time(entry.identityKeyExpiresAt);
  if (!entry.identityKey || !Number.isFinite(keyExpiry) || now <= keyExpiry) return entry;
  return withoutIdentityKey(entry);
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
    const now = Date.now();
    return parsed
      .filter(isRecentSignature)
      .filter((entry) => !isRecentSignatureExpired(entry, now))
      .map((entry) => withoutExpiredKey(entry, now));
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

/** Merges `patch` into one entry (e.g. a pending round's `expiresAt`).
 * Never throws; no-op if the entry is gone. */
export function updateRecentSignature(code: string, patch: Partial<RecentSignature>): void {
  if (typeof window === 'undefined') return;
  const current = getRecentSignatures();
  if (!current.some((existing) => existing.code === code)) return;
  writeList(current.map((existing) => (existing.code === code ? { ...existing, ...patch, code } : existing)));
}

/** Drops an entry's identityKey -- called once its signed PDF is stored
 * locally, after which the key is no longer needed. */
export function forgetIdentityKey(code: string): void {
  if (typeof window === 'undefined') return;
  const current = getRecentSignatures();
  if (!current.some((existing) => existing.code === code && existing.identityKey)) return;
  writeList(
    current.map((existing) => (existing.code === code ? withoutIdentityKey(existing) : existing))
  );
}

/** Rewrites the stored list without expired entries / expired keys (reads
 * already hide them; this makes it stick) and returns what is left. */
export function cleanupRecentSignatures(): RecentSignature[] {
  if (typeof window === 'undefined') return [];
  const kept = getRecentSignatures();
  writeList(kept);
  return kept;
}

export function clearRecentSignatures(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // non-critical
  }
}
