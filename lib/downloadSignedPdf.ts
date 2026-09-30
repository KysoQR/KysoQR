import { parseJsonSafely } from './http';

/**
 * Extracted from `SigningWizard.tsx` (was a private `useCallback` there) so
 * the home page's "recent signatures" download button can reuse the exact
 * same call instead of a second copy.
 *
 * IMPORTANT — shared, scarce budget: `identityKey` is only usable ~5 times
 * total with CAS (not just time-limited) before it stops working. Every
 * caller of this function, from any surface (the signing wizard's Done step
 * or the home page's recent-signatures list), draws from that same total —
 * CAS gives no way to know in advance how many uses remain, only failing the
 * call once they're spent. Callers must surface that failure clearly rather
 * than treating it as a generic/unexpected error.
 */
export async function downloadSignedPdfBlob(identityKey: string): Promise<Blob> {
  const res = await fetch(`/api/sign/download?identityKey=${encodeURIComponent(identityKey)}`);
  if (!res.ok) {
    const data = await parseJsonSafely(res).catch(() => ({}));
    // `detail` (CAS errorCode/status, or a timeout flag) previously only
    // ever reached the server's own terminal log -- log the full body here
    // so both callers (the signing wizard's Done step and the home page's
    // recent-signatures download button) show the same thing in DevTools on
    // a real deploy, not just a generic on-screen message.
    console.error('[sign:download] failed', data);
    throw new Error(data.message ?? 'Không tải được file đã ký');
  }
  return res.blob();
}

/** Download name for a signed copy: the original document name plus a
 * `_signed` suffix (so it never collides with the unsigned original), or
 * `signed.pdf` when the original name is unknown. A name that already ends in
 * `signed` (the `signed.pdf` fallback, or re-signing an already-signed copy)
 * is kept as-is rather than growing `_signed_signed`. */
export function signedFileName(originalName: string | null | undefined): string {
  const base = originalName?.trim().replace(/\.pdf$/i, '');
  if (!base) return 'signed.pdf';
  return /(^|[_\s-])signed$/i.test(base) ? `${base}.pdf` : `${base}_signed.pdf`;
}

/** Triggers the browser's own save-file flow for a blob, without navigating
 * away from the current page. */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
