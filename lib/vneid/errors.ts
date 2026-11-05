/**
 * Errors the VNeID signing service raises. `code` is what the API routes put
 * in `{ error }` and branch on; `httpStatus` is the status they answer with;
 * `message` is for the server log only (the routes write their own text for
 * the user). `detail` carries non-personal diagnostics for the log, never for
 * the client.
 */

export type VneidErrorCode =
  /** Required env vars missing, or no node:sqlite (Cloudflare Workers). */
  | 'VNEID_NOT_CONFIGURED'
  /** Request not sent by a page of this site (Origin check). */
  | 'VNEID_FORBIDDEN_ORIGIN'
  /** Turnstile (anti-bot) token missing or refused. */
  | 'VNEID_CHALLENGE_FAILED'
  | 'VNEID_LENGTH_REQUIRED'
  | 'VNEID_PAYLOAD_TOO_LARGE'
  | 'VNEID_UNSUPPORTED_MEDIA_TYPE'
  | 'VNEID_INVALID_INPUT'
  /** The PDF cannot be signed (encrypted, locked, too large, bad box...). */
  | 'VNEID_PDF_REJECTED'
  /** This citizen already has a request waiting on VNeID (here or at CSign). */
  | 'VNEID_REQUEST_PENDING'
  /** Too many unfinished requests for this citizen lately. */
  | 'VNEID_CITIZEN_LIMITED'
  /** The service-wide daily cap of sign requests is reached. */
  | 'VNEID_DAILY_CAP'
  /** No usable certificate for this CCCD at CSign. */
  | 'VNEID_NO_CERTIFICATE'
  /** A certificate exists but is not activated, expired or broken. */
  | 'VNEID_CERT_INVALID'
  /** The certificate registration form is incomplete or malformed. */
  | 'VNEID_REGISTRATION_INVALID'
  /** This citizen already has a registration (or a request) waiting. */
  | 'VNEID_REGISTRATION_PENDING'
  /** Too many registrations for this citizen lately. */
  | 'VNEID_REGISTRATION_LIMITED'
  /** The citizen already has this provider's free certificate. */
  | 'VNEID_ALREADY_REGISTERED'
  /** The provider or its service pack is unknown or disabled at CSign. */
  | 'VNEID_PROVIDER_UNAVAILABLE'

  /** Two PDF jobs are already running. */
  | 'VNEID_BUSY'
  /** CSign failed, timed out or answered something we cannot use. */
  | 'VNEID_UPSTREAM'
  /** Unknown transaction or wrong client secret (deliberately the same). */
  | 'VNEID_NOT_FOUND'
  /** Finalize asked for before the signature arrived. */
  | 'VNEID_NOT_READY'
  /** The PDF sent to finalize is not the one that was prepared. */
  | 'VNEID_DOCUMENT_MISMATCH'
  | 'VNEID_FINALIZE_LIMIT'
  | 'VNEID_CODE_INVALID'
  /** The signed file failed the post-signing check (fail closed). */
  | 'VNEID_SELF_CHECK_FAILED'
  | 'VNEID_INTERNAL';

const HTTP_STATUS: Record<VneidErrorCode, number> = {
  VNEID_NOT_CONFIGURED: 503,
  VNEID_FORBIDDEN_ORIGIN: 403,
  VNEID_CHALLENGE_FAILED: 403,
  VNEID_LENGTH_REQUIRED: 411,
  VNEID_PAYLOAD_TOO_LARGE: 413,
  VNEID_UNSUPPORTED_MEDIA_TYPE: 415,
  VNEID_INVALID_INPUT: 400,
  VNEID_PDF_REJECTED: 422,
  VNEID_REQUEST_PENDING: 409,
  VNEID_CITIZEN_LIMITED: 429,
  VNEID_DAILY_CAP: 503,
  VNEID_NO_CERTIFICATE: 422,
  VNEID_CERT_INVALID: 422,
  VNEID_REGISTRATION_INVALID: 400,
  VNEID_REGISTRATION_PENDING: 409,
  VNEID_REGISTRATION_LIMITED: 429,
  VNEID_ALREADY_REGISTERED: 409,
  VNEID_PROVIDER_UNAVAILABLE: 422,

  VNEID_BUSY: 503,
  VNEID_UPSTREAM: 502,
  VNEID_NOT_FOUND: 404,
  VNEID_NOT_READY: 409,
  VNEID_DOCUMENT_MISMATCH: 409,
  VNEID_FINALIZE_LIMIT: 429,
  VNEID_CODE_INVALID: 403,
  VNEID_SELF_CHECK_FAILED: 500,
  VNEID_INTERNAL: 500,
};

export type VneidLogDetail = Record<string, string | number | boolean | undefined>;

/** Recognized across module copies (see CsignError in csignClient.ts). */
const VNEID_ERROR = Symbol.for('kysoqr.vneid.VneidError');

export class VneidError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && VNEID_ERROR in value;
  }

  readonly code: VneidErrorCode;
  readonly httpStatus: number;
  readonly detail: VneidLogDetail | undefined;
  /** Seconds the client should wait before retrying (429 / 503). */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: VneidErrorCode,
    message: string,
    options: { detail?: VneidLogDetail; retryAfterSeconds?: number } = {}
  ) {
    super(message);
    Object.defineProperty(this, VNEID_ERROR, { value: true });
    this.name = 'VneidError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.detail = options.detail;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function isVneidError(value: unknown): value is VneidError {
  return value instanceof VneidError;
}
