/**
 * Errors raised by the PDF signing library. `code` is the only part callers
 * are meant to branch on; `message` is for server logs (never shown to end
 * users -- the routes map each code to a Vietnamese message).
 *
 * This module (like everything under lib/pdfSign) is loaded by a worker
 * thread through Node's native TypeScript support, so it sticks to erasable
 * syntax: no enums, no parameter properties, explicit `.ts` import suffixes.
 */

export type PdfSignErrorCode =
  /** Not a PDF, or its structure cannot be read. */
  | 'PDF_INVALID'
  | 'PDF_ENCRYPTED'
  /** Certified (DocMDP P=1) or field-locked: adding a signature would break it. */
  | 'PDF_LOCKED'
  /** Readable, but something we refuse to sign (XFA, bombs, odd page boxes...). */
  | 'PDF_UNSUPPORTED'
  | 'PDF_TOO_LARGE'
  | 'PDF_TOO_MANY_PAGES'
  /** Signature box / appearance text rejected. */
  | 'FIELD_INVALID'
  | 'SIGNATURE_TOO_LARGE'
  /** The RSA signature does not verify against the certificate + signed attributes. */
  | 'SIGNATURE_INVALID'
  | 'CMS_INVALID'
  /** The bytes being finalized are not the bytes that were prepared. */
  | 'FINALIZE_MISMATCH'
  /** The signed result failed the structural self-check (fail closed). */
  | 'SELF_CHECK_FAILED'
  | 'JOB_BUSY'
  | 'JOB_TIMEOUT'
  | 'JOB_FAILED';

/** The app may load this module more than once (each Next.js route bundle,
 * instrumentation.ts): `instanceof` goes by a brand so an error made by any
 * copy -- the worker runner's included -- is recognized by all. */
const PDF_SIGN_ERROR = Symbol.for('kysoqr.pdfSign.PdfSignError');

export class PdfSignError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && PDF_SIGN_ERROR in value;
  }

  readonly code: PdfSignErrorCode;

  constructor(code: PdfSignErrorCode, message: string) {
    super(message);
    Object.defineProperty(this, PDF_SIGN_ERROR, { value: true });
    this.name = 'PdfSignError';
    this.code = code;
  }
}

export function isPdfSignError(value: unknown): value is PdfSignError {
  return value instanceof PdfSignError;
}
