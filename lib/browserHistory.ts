import { getActiveSession } from './activeSession';
import {
  cleanupRecentSignatures,
  clearRecentSignatures,
  getRecentSignatures,
} from './recentSignatures';
import { clearAllStoredPdfs, pruneSignedPdfs } from './signedPdfStore';
import { clearSigningSession, migrateLegacyLocalStorage } from './signingSessionStorage';

/**
 * Housekeeping for everything the app keeps in this browser: the recent
 * list (localStorage), the PDFs (IndexedDB) and this tab's round
 * (sessionStorage).
 */

/** Drop stored PDFs no longer referenced by the recent list or by the
 * session on screen in this tab. */
export function pruneStoredPdfs(): Promise<void> {
  const keep = getRecentSignatures().map((entry) => entry.code);
  const active = getActiveSession();
  if (active) keep.push(active.code);
  return pruneSignedPdfs(keep);
}

/** On opening the home page: expire old / stale entries (7-day TTL, pending
 * rounds past their QR expiry, expired download keys), delete PDFs nothing
 * refers to any more, and clear keys older versions left in localStorage. */
export async function cleanupBrowserStorage(): Promise<void> {
  migrateLegacyLocalStorage();
  cleanupRecentSignatures();
  await pruneStoredPdfs();
}

/** "Xoá lịch sử trên máy này": everything this app stored in the browser. */
export async function clearBrowserHistory(): Promise<void> {
  clearRecentSignatures();
  clearSigningSession();
  migrateLegacyLocalStorage();
  await clearAllStoredPdfs();
}
