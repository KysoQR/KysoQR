/**
 * Port to the CAS e-signing API (Model B, document-push). One implementation,
 * `CasEsignProvider` — real HTTP calls to the CAS e-signing backend.
 *
 * Shapes below mirror x-sign-api's cas-esign/types.ts as closely as possible;
 * the business rules each real call must honor are enforced in the route
 * handlers that call this interface and in CasEsignProvider itself.
 */

/** A signature box in CAS's own convention (yRatio = bottom edge from page bottom). */
export interface CasSignatureField {
  page: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
  fieldType: 'SIGNATURE';
}

export interface SubmitDocumentInput {
  signRequestId: string;
  signatureFields: CasSignatureField[];
  /** 10..240 chars, no control characters — caller must normalize first. */
  documentName: string;
  organizationName?: string | null;
  /** PERSONAL / BUSINESS: the signer must sign that way and can't switch in
   * Cas ID. Omit to let the signer choose. */
  signType?: 'PERSONAL' | 'BUSINESS' | null;
  /** BUSINESS only: the signer must use THIS enterprise's certificate. */
  taxCode?: string | null;
  language?: 'vi' | 'en' | null;
  file: { buffer: Buffer; filename: string; contentType?: string };
  /** Omit for QR-only signing; supply to also push a notification to Cas ID. */
  identificationNumber?: string | null;
}

export interface SubmitDocumentResult {
  signRequestId: string;
  signToken: string;
  state: string;
  /** e.g. https://scan2grant.bankhub.vn?signToken=... */
  qrContent: string;
}

/**
 * Mirrors the real CAS `request-status` response. `orgIdSigned`/`expiresIn` are
 * NOT documented on CAS's official API reference — treat both as unconfirmed
 * until verified against a real sandbox call.
 */
export interface RequestStatusResult {
  signRequestId: string;
  state: string;
  lastUpdatedAt: string | null;
  signedAt: string | null;
  identityKey: string | null;
  identityKeyExpiresAt: string | null;
  /** Unconfirmed against official CAS docs — optional, UI must tolerate absence. */
  orgIdSigned?: string | null;
  /** Unconfirmed against official CAS docs — optional, UI must tolerate absence. */
  expiresIn?: number | null;
}

export interface DownloadFileResult {
  bytes: Uint8Array;
  contentType: string;
}

export interface SigningRoundCertParty {
  commonName: string | null;
  organization?: string | null;
  country: string | null;
  taxOrCitizenId?: string | null;
}

export interface SigningRoundCertificate {
  issuer: SigningRoundCertParty;
  signer: SigningRoundCertParty;
  documentIntegrity: string;
  validFrom: string | null;
  validTo: string | null;
  signatureValidity: string;
  hasTimestamp: string;
  signedAtLong: string | null;
}

/** CAS hasn't documented this object's fields; rendered generically. */
export type SigningRoundDevice = Record<string, unknown>;

export interface SigningRoundDetail {
  device: SigningRoundDevice;
  signer: { displayName: string };
  authMethod: string;
  signedAt: string | null;
  certificate: SigningRoundCertificate;
}

export interface SigningRoundResult {
  signingRound: SigningRoundDetail | null;
}

export interface CasProvider {
  submitDocument(input: SubmitDocumentInput): Promise<SubmitDocumentResult>;
  requestStatus(signRequestId: string): Promise<RequestStatusResult>;
  downloadFile(identityKey: string): Promise<DownloadFileResult>;
  getSigningRound(orgIdSigned: string): Promise<SigningRoundResult>;

  /** True when `error` is CAS's "identificationNumber is not a registered Cas ID user". */
  isPersonNotFoundError(error: unknown): boolean;
  /** True when `error` is CAS's HTTP 429 (rate limited). */
  isRateLimitedError(error: unknown): boolean;
  /** True when `error` is CAS's "signing round not found / not completed yet". */
  isSigningRoundNotFoundError(error: unknown): boolean;
  /** True when `error` is CAS's "no digital certificate on file for this
   * person" -- distinct from isPersonNotFoundError (that one triggers an
   * automatic QR-only retry; this one means the identificationNumber IS a
   * known Cas ID user, but has no CTS/certificate registered at all, so
   * retrying can't help). */
  isCertificateNotFoundError(error: unknown): boolean;
}
