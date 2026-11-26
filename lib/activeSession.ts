/**
 * The signing session currently on screen in the wizard once it has a
 * result -- a signed round (review mode) or one that ended without a
 * signature -- so a reload (F5) reopens it instead of dropping back to the
 * home page. A round still waiting for the signer is persisted separately
 * (SigningWizard's `kysoqr.signRequestId`/... keys) and isn't stored here.
 *
 * `code` is the IndexedDB key of the PDF to show (`lib/signedPdfStore.ts`):
 * the orgIdSigned for a signed round, `pending:<signRequestId>` (the
 * original file) for a failed one. Cleared whenever the user moves on
 * (sign again, a new document, back to home). Never throws.
 */

import type { SignatureFieldProps } from './domain/SignatureField';

import { SESSION_KEYS, getSessionItem, removeSessionItem, setSessionItem } from './signingSessionStorage';

const STORAGE_KEY = SESSION_KEYS.activeSession;

export interface ActiveSession {
  kind: 'signed' | 'failed';
  code: string;
  /** Document name to show. */
  name: string;
  /** Failed sessions: REJECTED / EXPIRED / FAILED. */
  status?: string;
  /** Failed sessions: the boxes that were sent (hidden on screen, but back
   * with "Ký lại" even after a reload). */
  signatureFields?: SignatureFieldProps[];
}

export function getActiveSession(): ActiveSession | null {
  try {
    const raw = getSessionItem(STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    if ((v.kind !== 'signed' && v.kind !== 'failed') || typeof v.code !== 'string' || typeof v.name !== 'string') {
      return null;
    }
    return {
      kind: v.kind,
      code: v.code,
      name: v.name,
      status: typeof v.status === 'string' ? v.status : undefined,
      signatureFields: Array.isArray(v.signatureFields)
        ? (v.signatureFields as SignatureFieldProps[])
        : undefined,
    };
  } catch {
    return null;
  }
}

export function setActiveSession(session: ActiveSession): void {
  setSessionItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearActiveSession(): void {
  removeSessionItem(STORAGE_KEY);
}
