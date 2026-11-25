/**
 * Per-tab state of the signing round on screen -- the round waiting for the
 * signer (its request id, QR, ...), a just-signed round's download key, and
 * the result on screen (`lib/activeSession.ts`).
 *
 * `sessionStorage`, not `localStorage`: it survives a reload (F5) of the
 * same tab but not a new tab, so two tabs never overwrite each other's
 * round, and opening the site fresh lands on the home page instead of
 * reopening an old session. Rounds stay reachable across tabs through the
 * home page's recent list (`lib/recentSignatures.ts`, in localStorage).
 * Every helper is best-effort and never throws.
 */

export const SESSION_KEYS = {
  signRequestId: 'kysoqr.signRequestId',
  status: 'kysoqr.status',
  identityKey: 'kysoqr.identityKey',
  identityKeyExpiresAt: 'kysoqr.identityKeyExpiresAt',
  orgIdSigned: 'kysoqr.orgIdSigned',
  documentName: 'kysoqr.documentName',
  createdAt: 'kysoqr.createdAt',
  // The QR/link CAS returned for the pending round, so a reload while
  // waiting still shows the same QR.
  qrContent: 'kysoqr.qrContent',
  activeSession: 'kysoqr.activeSession',
} as const;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function getSessionItem(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setSessionItem(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // full / disabled -- non-critical
  }
}

export function removeSessionItem(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    // non-critical
  }
}

/** Forgets everything about this tab's signing round. */
export function clearSigningSession(): void {
  for (const key of Object.values(SESSION_KEYS)) removeSessionItem(key);
}

/** Earlier versions kept these keys in localStorage (shared by every tab,
 * kept forever, identityKey included): remove them once. */
export function migrateLegacyLocalStorage(): void {
  try {
    if (typeof window === 'undefined') return;
    for (const key of Object.values(SESSION_KEYS)) window.localStorage.removeItem(key);
  } catch {
    // non-critical
  }
}
