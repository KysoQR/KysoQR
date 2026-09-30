import { CAS_MAX_FILE_BYTES } from '@/lib/documentName';

/** Ported verbatim from x-sign-web/src/components/signing/constants.ts.
 * Upload cap for *verifying* a PDF (`/api/verify/upload`). */
export const MAX_UPLOAD_SIZE_MB = 20;

/** Upload cap for *signing*: CAS rejects anything larger, so the signing UI
 * uses this instead of `MAX_UPLOAD_SIZE_MB` -- derived from the same constant
 * `/api/sign/request` enforces, so the two can't drift apart. */
export const MAX_SIGN_UPLOAD_SIZE_MB = CAS_MAX_FILE_BYTES / (1024 * 1024);

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}
