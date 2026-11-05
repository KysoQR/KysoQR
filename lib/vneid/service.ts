import { randomInt, randomUUID, X509Certificate } from 'node:crypto';
import type { ExpectedAfter, PdfAnalysis } from '../pdfSign/analyze';
import { isPdfSignError } from '../pdfSign/errors';
import type { FieldPlacement } from '../pdfSign/geometry';
import type { FinalizeJobInput, PrepareJobInput } from '../pdfSign/jobs';
import { MAX_FIELDS, MAX_NAME_CHARS, MAX_PDF_BYTES } from '../pdfSign/limits';
import type { PrepareResult } from '../pdfSign/prepare';
import { analyzeInWorker, finalizeInWorker, prepareInWorker } from '../pdfSign/runner';
import { sanitizeDisplayText } from '../pdfSign/text';
import { getTrustStore } from '../trustStore/getTrustStore';
import type { TrustStore } from '../trustStore/TrustStore';
import {
  type DetailedVerificationResult,
  verifyPdfSignaturesDetailed,
} from '../verification/verifyPdfSignatures';
import {
  type CertPolicyFailure,
  type ChainCheck,
  CertPolicyError,
  chooseCredential,
  evaluateCredentials,
  summarizeCredential,
  withPinnedRoot,
} from './certPolicy';
import { getVneidConfig, type VneidConfig, VneidConfigError } from './config';
import {
  citizenKey,
  deriveKeys,
  hashClientSecret,
  hmacSha256,
  ipKey,
  newClientSecret,
  open,
  safeEqual,
  seal,
  sha256,
  type VneidKeys,
} from './crypto';
import { type CsignApi, CsignClient, CsignError, type QueryStatusResult } from './csignClient';
import { VneidError, type VneidLogDetail } from './errors';
import { loadOrCreateLocalSecret } from './localSecret';
import { decodeBase64Strict, diagnoseSignature } from './signatureDiagnostics';
import { type EndStatus, type TransactionRow, VneidStore } from './store';
import { timestampFromAny, type TimestampSource, TsaError } from './tsa';

/**
 * VNeID signing, start to finish, without HTTP: the API routes only parse the
 * request, call one of these functions and turn the result (or VneidError)
 * into a response.
 *
 *   startSigning     PDF + boxes + CCCD -> CSign push to the citizen's VNeID app
 *   getStatus        where the request stands (asks CSign only while it can matter)
 *   applyCsignResult a CSign result (status poll or webhook) -> the transaction
 *   finalizeSigning  original PDF again -> the signed PDF, checked before release
 *
 * Nothing the browser sends is trusted beyond what it is: the PDF, the boxes,
 * the CCCD, the language, and later the transaction id + client secret it was
 * given. Everything sent to CSign is generated here; everything CSign returns
 * is checked (certificate policy before the push, signature math before it is
 * stored, the finished file before it is released).
 */

// ---- timing and limits (CSign spec: 5 min to confirm, 30 min per transaction) -----

export const CONFIRM_WINDOW_MS = 5 * 60_000;
export const TRANSACTION_TTL_MS = 30 * 60_000;
/** query-status is asked often until the confirm deadline plus this much... */
const STATUS_POLL_GRACE_MS = 60_000;
/** ...at most once per this interval per transaction... */
const STATUS_CHECK_INTERVAL_MS = 5_000;
/** ...then once per this interval until the transaction expires: without a
 * webhook, asking is the only way a late result arrives. */
const LATE_STATUS_CHECK_INTERVAL_MS = 60_000;
/** Room kept in /Contents for the timestamp token (a TSA token with its
 * certificates is usually 5-7 KB). */
const TIMESTAMP_RESERVE_BYTES = 12 * 1024;
/** A request stuck before sign-hash returned is abandoned after this. */
const SUBMITTING_TTL_MS = 2 * 60_000;
/** A signature arriving this long after our own expiry is still accepted. */
const LATE_SIGNATURE_GRACE_MS = 5 * 60_000;
/** Finished transactions and webhook events are kept this long. */
const KEEP_MS = 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const MAX_FINALIZE_PER_TRANSACTION = 5;
const MAX_CODE_ATTEMPTS = 5;
/** Refused / ignored requests per citizen per day before a pause... */
const CITIZEN_MISS_LIMIT = 10;
/** ...of this long after the latest one. */
const CITIZEN_PAUSE_MS = 60 * 60_000;
/** Prepared data kept per transaction (appended PDF bytes + metadata). */
const MAX_PREPARED_BYTES = 1024 * 1024;
const MAINTENANCE_INTERVAL_MS = 60_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

// ---- dependencies ---------------------------------------------------------------------

export interface PdfJobsApi {
  analyze(pdf: Buffer): Promise<PdfAnalysis>;
  prepare(input: PrepareJobInput): Promise<PrepareResult>;
  finalize(input: FinalizeJobInput): Promise<Buffer>;
}

export interface VneidDeps {
  config: VneidConfig;
  keys: VneidKeys;
  store: VneidStore;
  csign: CsignApi;
  trustStore: TrustStore;
  pdf: PdfJobsApi;
  /** RFC 3161 timestamps for the signature; absent = none (TSA_URL=off). */
  tsa?: TimestampSource | undefined;
  now: () => number;
}

const workerJobs: PdfJobsApi = {
  analyze: (pdf) => analyzeInWorker(pdf),
  prepare: (input) => prepareInWorker(input),
  finalize: (input) => finalizeInWorker(input),
};

/**
 * Kept on globalThis, not in a module variable: Next.js may load this module
 * once per route bundle (and once more for instrumentation.ts), and every
 * copy would otherwise log in to CSign on its own and open its own SQLite
 * connection. One process, one CSign session (access + refresh token), one
 * database handle.
 */
const DEPS_KEY = Symbol.for('kysoqr.vneid.deps');
const globalDeps = globalThis as typeof globalThis & { [DEPS_KEY]?: VneidDeps };

/** The production wiring. Throws VNEID_NOT_CONFIGURED (and logs why, variable
 * names only) when env is incomplete or SQLite cannot be opened. */
export function getVneidDeps(): VneidDeps {
  const existing = globalDeps[DEPS_KEY];
  if (existing) return existing;
  let config: VneidConfig;
  try {
    config = getVneidConfig();
  } catch (error) {
    if (error instanceof VneidConfigError) {
      console.error('[vneid:config] VNeID signing is not configured', { problems: error.problems });
      throw new VneidError('VNEID_NOT_CONFIGURED', error.message);
    }
    throw error;
  }
  let store: VneidStore;
  try {
    store = VneidStore.open(config.dbPath);
  } catch (error) {
    console.error('[vneid:config] cannot open the VNeID database', {
      message: error instanceof Error ? error.message : String(error),
    });
    throw new VneidError('VNEID_NOT_CONFIGURED', 'VNeID database unavailable');
  }
  let secret: Buffer;
  try {
    const local = loadOrCreateLocalSecret(config.dbPath);
    secret = local.secret;
    if (local.created) {
      console.info('[vneid:config] created the store key next to the database', {
        keyFile: local.file,
      });
    }
  } catch (error) {
    store.close();
    console.error('[vneid:config] cannot read or create the VNeID key file', {
      message: error instanceof Error ? error.message : String(error),
    });
    throw new VneidError('VNEID_NOT_CONFIGURED', 'VNeID key unavailable');
  }
  const deps: VneidDeps = {
    config,
    keys: deriveKeys(secret),
    store,
    csign: new CsignClient(config.csign.baseUrl, config.csign.username, config.csign.password),
    trustStore: getTrustStore(),
    pdf: workerJobs,
    tsa: config.tsaUrls.length > 0 ? timestampFromAny(config.tsaUrls) : undefined,
    now: Date.now,
  };
  globalDeps[DEPS_KEY] = deps;
  return deps;
}

// ---- input validation (the routes call these before anything else) -----------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_PATTERN = /^[A-Z0-9]{6}$/;

/** 12 digits whose first three are a province code (001-096). */
export function isValidCitizenPid(value: string): boolean {
  if (!/^[0-9]{12}$/.test(value)) return false;
  const province = Number(value.slice(0, 3));
  return province >= 1 && province <= 96;
}

export const isTransactionId = (value: string) => UUID_PATTERN.test(value);
export const isClientSecret = (value: string) => CLIENT_SECRET_PATTERN.test(value);

/** Boxes in the UI convention (ratios of the displayed page). */
export function areValidFields(fields: FieldPlacement[]): boolean {
  if (fields.length < 1 || fields.length > MAX_FIELDS) return false;
  return fields.every(
    (field) =>
      Number.isInteger(field.page) &&
      field.page >= 1 &&
      [field.xRatio, field.yRatio, field.widthRatio, field.heightRatio].every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1
      ) &&
      field.widthRatio > 0 &&
      field.heightRatio > 0 &&
      field.xRatio + field.widthRatio <= 1 &&
      field.yRatio + field.heightRatio <= 1
  );
}

// ---- sealed data ------------------------------------------------------------------------

interface StoredChain {
  certificate: string;
  chain: string[];
  root: string | null;
  rootTrusted: boolean;
  chainVerified: boolean;
}

interface StoredPrepared {
  tail: string;
  byteRange: [number, number, number, number];
  contentsOffset: number;
  contentsLength: number;
  contentDigest: string;
  signedAttrsDer: string;
  analysis: PdfAnalysis;
  expected: ExpectedAfter;
}

interface OpenedChain {
  certificateDer: Buffer;
  chainDer: Buffer[];
  rootDer: Buffer | undefined;
  rootTrusted: boolean;
  chainVerified: boolean;
}

interface OpenedPrepared {
  tail: Buffer;
  byteRange: [number, number, number, number];
  contentsOffset: number;
  contentsLength: number;
  contentDigest: Buffer;
  signedAttrsDer: Buffer;
  analysis: PdfAnalysis;
  expected: ExpectedAfter;
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const unb64 = (text: string) => Buffer.from(text, 'base64');

function sealJson(keys: VneidKeys, id: string, column: string, value: unknown): Buffer {
  return seal(keys.enc, Buffer.from(JSON.stringify(value), 'utf8'), `${id}:${column}`);
}

function openJson<T>(keys: VneidKeys, id: string, column: string, sealed: Buffer | null): T {
  if (!sealed) throw new VneidError('VNEID_INTERNAL', `transaction has no ${column}`);
  try {
    return JSON.parse(open(keys.enc, sealed, `${id}:${column}`).toString('utf8')) as T;
  } catch {
    // Altered data, or the key file was replaced since: fail closed.
    throw new VneidError('VNEID_INTERNAL', `${column} cannot be opened`);
  }
}

function openChain(deps: VneidDeps, row: TransactionRow): OpenedChain {
  const stored = openJson<StoredChain>(deps.keys, row.id, 'cert_chain', row.certChainEnc);
  return {
    certificateDer: unb64(stored.certificate),
    chainDer: stored.chain.map(unb64),
    rootDer: stored.root ? unb64(stored.root) : undefined,
    rootTrusted: stored.rootTrusted === true,
    chainVerified: stored.chainVerified === true,
  };
}

function openPrepared(deps: VneidDeps, row: TransactionRow): OpenedPrepared {
  const stored = openJson<StoredPrepared>(deps.keys, row.id, 'prepared', row.preparedEnc);
  return {
    ...stored,
    tail: unb64(stored.tail),
    contentDigest: unb64(stored.contentDigest),
    signedAttrsDer: unb64(stored.signedAttrsDer),
  };
}

// ---- housekeeping -----------------------------------------------------------------------

let lastMaintenanceAt = 0;
let lastSweepAt = 0;

/** Expires overdue requests (and, hourly, drops old rows). Cheap; throttled. */
export function maintain(deps: VneidDeps): void {
  const now = deps.now();
  if (now - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return;
  lastMaintenanceAt = now;
  deps.store.expireOverdue(now, SUBMITTING_TTL_MS);
  if (now - lastSweepAt >= 60 * 60_000) {
    lastSweepAt = now;
    deps.store.sweep(now, KEEP_MS, deps.config.auditDays * DAY_MS);
  }
}

/** Test-only. */
export function resetVneidServiceForTests(): void {
  globalDeps[DEPS_KEY]?.store.close();
  delete globalDeps[DEPS_KEY];
  lastMaintenanceAt = 0;
  lastSweepAt = 0;
}

// ---- startSigning -----------------------------------------------------------------------

export interface StartSigningInput {
  pdf: Buffer;
  fields: FieldPlacement[];
  citizenPid: string;
  language: 'vi' | 'en';
  clientIp?: string | undefined;
  /** The certificate the user picked from /api/vneid/credentials. Only the id
   * is taken from the browser: the certificate is fetched and checked again. */
  credentialId?: string | undefined;
}

export interface StartSigningResult {
  transactionId: string;
  clientSecret: string;
  confirmDeadline: number;
  expiresAt: number;
  /** The confirmation code shown on VNeID must be typed back at finalize. */
  codeRequired: boolean;
  /** The document name the citizen sees in the VNeID notification. */
  documentName: string;
}

/** Vietnam keeps UTC+7 all year (no daylight saving time). */
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
/** Keeps the label, the date and the time on one line (sanitizeDisplayText lets it through). */
const NO_BREAK_SPACE = String.fromCharCode(0xa0);

/**
 * The box as CAS draws it: the signer's name, the date and time, the UTC
 * offset. The time is the request's, to the second the same instant as /M:
 * the box is fixed before the citizen confirms. The time of the confirmation
 * itself is carried by the RFC 3161 timestamp (tsa.ts).
 */
export function appearanceFor(name: string, language: 'vi' | 'en', signingTimeMs: number) {
  const local = new Date(signingTimeMs + VIETNAM_OFFSET_MS);
  const two = (value: number) => String(value).padStart(2, '0');
  const date = `${two(local.getUTCDate())}/${two(local.getUTCMonth() + 1)}/${local.getUTCFullYear()}`;
  const time = `${two(local.getUTCHours())}:${two(local.getUTCMinutes())}:${two(local.getUTCSeconds())}`;
  const label = language === 'en' ? 'Date' : 'Ngày';
  return {
    name,
    details: [`${label}:${NO_BREAK_SPACE}${date}${NO_BREAK_SPACE}${time}`, '+07:00'],
  };
}

function newConfirmationCode(): string {
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

const codeHash = (keys: VneidKeys, id: string, code: string) =>
  hmacSha256(keys.hmac, `code:${id}:${code}`);

/** What the citizen sees on VNeID: nothing from the file, only a short
 * fingerprint of it (and the code, when codes are on). */
function documentNameFor(documentSha256: Buffer, code: string | undefined): string {
  const fingerprint = documentSha256.toString('hex').slice(0, 8).toUpperCase();
  return code
    ? `KysoQR - Ký tài liệu ${fingerprint} - Mã ${code}`
    : `KysoQR - Ký tài liệu ${fingerprint}`;
}

/** Maps a failure while starting a request to the error the route reports. */
function startFailure(error: unknown): { error: VneidError; errorCode: string } {
  if (error instanceof VneidError) return { error, errorCode: error.code };
  if (error instanceof CertPolicyError) {
    const code = error.failure === 'NO_CREDENTIAL' ? 'VNEID_NO_CERTIFICATE' : 'VNEID_CERT_INVALID';
    return {
      error: new VneidError(code, error.message, {
        detail: { policy: error.failure, ...error.detail },
      }),
      errorCode: `CERT_${error.failure}`,
    };
  }
  if (error instanceof CsignError) {
    const detail: VneidLogDetail = {
      csignKind: error.kind,
      csignCode: error.code,
      path: error.path,
    };
    const code =
      error.kind === 'PENDING_OTHER'
        ? 'VNEID_REQUEST_PENDING'
        : error.kind === 'NO_CERTIFICATE'
          ? 'VNEID_NO_CERTIFICATE'
          : error.kind === 'CERT_INVALID'
            ? 'VNEID_CERT_INVALID'
            : 'VNEID_UPSTREAM';
    return {
      error: new VneidError(code, error.message, { detail }),
      errorCode: `CSIGN_${error.kind}`,
    };
  }
  if (isPdfSignError(error)) {
    const code =
      error.code === 'JOB_BUSY'
        ? 'VNEID_BUSY'
        : error.code === 'JOB_FAILED' || error.code === 'CMS_INVALID'
          ? 'VNEID_INTERNAL'
          : 'VNEID_PDF_REJECTED';
    return {
      error: new VneidError(code, error.message, { detail: { pdfCode: error.code } }),
      errorCode: `PDF_${error.code}`,
    };
  }
  return {
    error: new VneidError('VNEID_INTERNAL', error instanceof Error ? error.message : String(error)),
    errorCode: 'INTERNAL',
  };
}

export async function startSigning(
  deps: VneidDeps,
  input: StartSigningInput
): Promise<StartSigningResult> {
  if (!isValidCitizenPid(input.citizenPid)) {
    throw new VneidError('VNEID_INVALID_INPUT', 'citizen id is not a valid CCCD number');
  }
  if (!areValidFields(input.fields)) {
    throw new VneidError('VNEID_INVALID_INPUT', 'signature boxes are invalid');
  }
  if (input.pdf.length === 0 || input.pdf.length > MAX_PDF_BYTES) {
    throw new VneidError('VNEID_PDF_REJECTED', 'PDF size out of range', {
      detail: { bytes: input.pdf.length },
    });
  }
  maintain(deps);

  // 1. The file, in a worker: readable, signable, boxes on existing pages.
  let analysis: PdfAnalysis;
  try {
    analysis = await deps.pdf.analyze(input.pdf);
  } catch (error) {
    throw startFailure(error).error;
  }
  if (input.fields.some((field) => field.page > analysis.pageCount)) {
    throw new VneidError(
      'VNEID_INVALID_INPUT',
      'a signature box is on a page the PDF does not have'
    );
  }

  // 2. Limits: service-wide per day, and a pause for a citizen whose requests
  //    keep being refused or ignored (someone else typing their CCCD).
  const now = deps.now();
  const citizen = citizenKey(deps.keys, input.citizenPid);
  if (deps.store.countRequestsSince(now - DAY_MS) >= deps.config.dailyCap) {
    throw new VneidError('VNEID_DAILY_CAP', 'daily cap of signing requests reached', {
      retryAfterSeconds: 3600,
    });
  }
  const misses = deps.store.citizenMisses(citizen, now - DAY_MS);
  if (misses.count >= CITIZEN_MISS_LIMIT && misses.lastAt !== undefined) {
    const pausedUntil = misses.lastAt + CITIZEN_PAUSE_MS;
    if (pausedUntil > now) {
      throw new VneidError(
        'VNEID_CITIZEN_LIMITED',
        'too many unfinished requests for this citizen',
        {
          retryAfterSeconds: Math.ceil((pausedUntil - now) / 1000),
        }
      );
    }
  }

  // 3. Reserve the citizen's one open request.
  const id = randomUUID();
  const clientSecret = newClientSecret();
  const code = deps.config.requireCode ? newConfirmationCode() : undefined;
  const documentSha256 = sha256(input.pdf);
  const documentName = documentNameFor(documentSha256, code);
  const reserved = deps.store.reserve(
    {
      id,
      requestId: randomUUID(),
      documentId: randomUUID(),
      documentName,
      citizenKey: citizen,
      clientSecretHash: hashClientSecret(clientSecret),
      codeHash: code ? codeHash(deps.keys, id, code) : null,
      originalSha256: documentSha256,
      originalLength: input.pdf.length,
      prevSignatureCount: analysis.signatureCount,
      xrefKind: analysis.xrefKind,
      createdAt: now,
      confirmDeadline: now + CONFIRM_WINDOW_MS,
      expiresAt: now + TRANSACTION_TTL_MS,
    },
    {
      documentSha256: documentSha256.toString('hex'),
      ipKey: input.clientIp ? ipKey(deps.keys, input.clientIp) : undefined,
    },
    SUBMITTING_TTL_MS
  );
  if (reserved === 'citizen-busy') {
    throw new VneidError('VNEID_REQUEST_PENDING', 'this citizen already has an open request');
  }

  try {
    // 4. The certificate CSign would sign with -- checked before any push.
    const credential = chooseCredential(
      await deps.csign.listCredentials(input.citizenPid),
      input.citizenPid,
      { now: new Date(deps.now()), trustStore: deps.trustStore },
      input.credentialId
    );

    // 5. The incremental update and the digest to sign, in a worker.
    const signingTimeMs = deps.now();
    const signerName = sanitizeDisplayText(credential.signerName, MAX_NAME_CHARS) || 'VNeID';
    const prepared = await deps.pdf.prepare({
      pdf: input.pdf,
      fields: input.fields,
      appearance: appearanceFor(signerName, input.language, signingTimeMs),
      signingTimeMs,
      certificateDer: credential.certificateDer,
      chainDer: credential.chainDer,
      timestampReserveBytes: deps.tsa ? TIMESTAMP_RESERVE_BYTES : 0,
    });
    const storedPrepared: StoredPrepared = {
      tail: b64(prepared.tail),
      byteRange: prepared.byteRange,
      contentsOffset: prepared.contentsOffset,
      contentsLength: prepared.contentsLength,
      contentDigest: b64(prepared.contentDigest),
      signedAttrsDer: b64(prepared.signedAttrsDer),
      analysis: prepared.analysis,
      expected: prepared.expected,
    };
    const preparedEnc = sealJson(deps.keys, id, 'prepared', storedPrepared);
    if (preparedEnc.length > MAX_PREPARED_BYTES) {
      throw new VneidError('VNEID_PDF_REJECTED', 'prepared update too large', {
        detail: { bytes: preparedEnc.length },
      });
    }
    const storedChain: StoredChain = {
      certificate: b64(credential.certificateDer),
      chain: credential.chainDer.map(b64),
      root: credential.rootDer ? b64(credential.rootDer) : null,
      rootTrusted: credential.rootTrusted,
      chainVerified: credential.chainVerified,
    };
    const digestValue = b64(prepared.digestToSign);
    const attached = deps.store.attachPrepared(
      id,
      {
        digestValue,
        credentialId: credential.credentialId,
        certIssuerCn: credential.issuerCommonName,
        certValidTo: credential.validTo.getTime(),
        certChainEnc: sealJson(deps.keys, id, 'cert_chain', storedChain),
        preparedEnc,
      },
      deps.now()
    );
    if (!attached) throw new VneidError('VNEID_INTERNAL', 'request vanished while preparing');

    // 6. The push to the citizen's phone.
    const row = deps.store.get(id)!;
    const submitted = await deps.csign.signHash({
      credentialId: credential.credentialId,
      citizenPid: input.citizenPid,
      requestId: row.requestId,
      documentId: row.documentId,
      documentName,
      digestValue,
    });
    const sentAt = deps.now();
    const times = {
      now: sentAt,
      confirmDeadline: sentAt + CONFIRM_WINDOW_MS,
      expiresAt: sentAt + TRANSACTION_TTL_MS,
    };
    if (!deps.store.markSubmitted(id, submitted, times)) {
      throw new VneidError('VNEID_INTERNAL', 'request vanished after sign-hash');
    }
    if (!credential.chainVerified) {
      // Not refused (CSign itself reports the certificate as usable), but the
      // signed file will not show a verifiable CA chain.
      console.warn('[vneid:sign] the CA chain CSign sent does not link up with the certificate', {
        certificateIssuerCn: credential.issuerCommonName,
        ...credential.chainIssueDetail,
      });
    } else if (!credential.rootTrusted) {
      console.warn('[vneid:sign] certificate root is not a national root (test environment?)', {
        rootCn: credential.rootCommonName,
        rootSha256: credential.rootSha256,
      });
    }
    return {
      transactionId: id,
      clientSecret,
      confirmDeadline: times.confirmDeadline,
      expiresAt: times.expiresAt,
      codeRequired: code !== undefined,
      documentName,
    };
  } catch (error) {
    const failure = startFailure(error);
    deps.store.markEnded(id, 'FAILED', { errorCode: failure.errorCode }, deps.now());
    throw failure.error;
  }
}

// ---- results from CSign (status polling and webhook share this) ----------------------

export interface CsignResult {
  statusCode: number;
  errorCode: string | undefined;
  signatures: { documentId: string | undefined; signature: string }[];
  providerInternalId?: string | undefined;
  documentNumber?: string | undefined;
  /** When CSign says it was signed (webhook timestamp); defaults to now. */
  signedAt?: number | undefined;
}

export type ApplyOutcome =
  | 'signed'
  | 'progress'
  | 'rejected'
  | 'expired'
  | 'failed'
  | 'invalid_signature'
  | 'missing_signature'
  | 'unchanged';

/** CSign's terminal result codes (spec section V.4) for a transaction. */
function endStatusFor(result: CsignResult): EndStatus {
  const code = (result.errorCode ?? '').toLowerCase();
  if (result.statusCode === 5 || code === 'errorcode4004' || code === 'errorcode06')
    return 'REJECTED';
  if (code === 'errorcode4005' || code === 'errorcode4006' || code === 'errorcode07')
    return 'EXPIRED';
  return 'FAILED';
}

function pickSignature(row: TransactionRow, result: CsignResult): string | undefined {
  const mine = result.signatures.filter((entry) => entry.documentId === row.documentId);
  if (mine.length === 1) return mine[0]!.signature;
  // One document per transaction, and CSign lists signatures in the order of
  // the digests sent: a single signature is ours, even when CSign tagged it
  // with an id of its own (the UAT gateway does). The RSA check that follows
  // proves it signs this transaction's data, so a wrong one cannot get in.
  if (result.signatures.length === 1) {
    const only = result.signatures[0]!;
    if (only.documentId !== undefined) {
      console.info('[vneid:signature] CSign tagged the signature with its own documentId', {
        transactionId: row.id,
        documentIdSent: row.documentId,
        documentIdReturned: only.documentId,
      });
    }
    return only.signature;
  }
  console.warn('[vneid:signature] CSign reported success but no signature matches', {
    transactionId: row.id,
    documentIdSent: row.documentId,
    documentIdsReturned: result.signatures.map((entry) => entry.documentId ?? null),
  });
  return undefined;
}

/**
 * Applies one CSign result to a transaction. Synchronous on purpose (only
 * crypto and conditional UPDATEs), so the webhook can run it inside the same
 * store transaction that records the event.
 */
export function applyCsignResult(
  deps: VneidDeps,
  row: TransactionRow,
  result: CsignResult,
  source: 'webhook' | 'query-status'
): ApplyOutcome {
  const now = deps.now();
  if (result.statusCode === 4) {
    const encoded = pickSignature(row, result);
    if (encoded === undefined) return 'missing_signature';
    const signature = decodeBase64Strict(encoded);
    let diagnosis: string = 'UNREADABLE_BASE64';
    if (signature) {
      const chain = openChain(deps, row);
      const prepared = openPrepared(deps, row);
      diagnosis = diagnoseSignature({
        certificate: new X509Certificate(chain.certificateDer),
        signature,
        signedAttrsDer: prepared.signedAttrsDer,
        digestSent: sha256(prepared.signedAttrsDer),
      });
    }
    if (diagnosis !== 'OK' || !signature) {
      // The one line that tells us how CSign signs, if not as assumed.
      console.error(`[vneid:signature] VNEID_SIGNATURE_DIAGNOSIS=${diagnosis}`, {
        transactionId: row.id,
        source,
        bytes: signature?.length,
      });
      deps.store.markEnded(
        row.id,
        'FAILED',
        { errorCode: `DIAG_${diagnosis}`, csignStatus: 4 },
        now
      );
      return 'invalid_signature';
    }
    const stored = deps.store.markSigned(
      row.id,
      {
        signature,
        source,
        signedAt: result.signedAt ?? now,
        csignStatus: 4,
        providerInternalId: result.providerInternalId,
        documentNumber: result.documentNumber,
      },
      now,
      LATE_SIGNATURE_GRACE_MS
    );
    return stored ? 'signed' : 'unchanged';
  }
  if (result.statusCode === 0 || result.statusCode === 5) {
    const status = endStatusFor(result);
    const ended = deps.store.markEnded(
      row.id,
      status,
      {
        errorCode: result.errorCode ?? `CSIGN_STATUS_${result.statusCode}`,
        csignStatus: result.statusCode,
      },
      now
    );
    if (!ended) return 'unchanged';
    return status === 'REJECTED' ? 'rejected' : status === 'EXPIRED' ? 'expired' : 'failed';
  }
  if (result.statusCode >= 1 && result.statusCode <= 3) {
    return deps.store.markProgress(row.id, result.statusCode, now) ? 'progress' : 'unchanged';
  }
  return 'unchanged';
}

const fromQuery = (result: QueryStatusResult): CsignResult => ({
  statusCode: result.statusCode,
  errorCode: result.errorCode,
  signatures: result.signatures,
});

/** Asks CSign once (throttled per transaction). Errors are logged, not thrown:
 * the next poll or the webhook will try again. */
export async function refreshFromCsign(
  deps: VneidDeps,
  row: TransactionRow,
  minIntervalMs = STATUS_CHECK_INTERVAL_MS
): Promise<void> {
  if (!row.csignTransactionId) return;
  if (!deps.store.claimStatusCheck(row.id, deps.now(), minIntervalMs)) return;
  try {
    const result = await deps.csign.queryStatus(row.csignTransactionId);
    const fresh = deps.store.get(row.id);
    if (fresh) applyCsignResult(deps, fresh, fromQuery(result), 'query-status');
  } catch (error) {
    console.warn('[vneid:status] query-status failed', {
      transactionId: row.id,
      reason: error instanceof CsignError ? `${error.kind} ${error.code ?? ''}`.trim() : 'error',
    });
  }
}

// ---- getStatus --------------------------------------------------------------------------

export type PublicStatus =
  'PENDING' | 'WAITING_USER' | 'SIGNED' | 'FINALIZED' | 'REJECTED' | 'EXPIRED' | 'FAILED';

export interface StatusView {
  status: PublicStatus;
  /** Why it ended, for REJECTED / EXPIRED / FAILED. */
  reason?: 'REFUSED' | 'TIMEOUT' | 'SIGNATURE_UNUSABLE' | 'CODE_ATTEMPTS' | 'PROVIDER';
  confirmDeadline: number;
  expiresAt: number;
  codeRequired: boolean;
}

/** The row behind a transaction id + client secret; the same 404 for an unknown
 * id, a wrong secret or a malformed one. */
export function authenticate(
  deps: VneidDeps,
  transactionId: string,
  clientSecret: string
): TransactionRow {
  const notFound = () => new VneidError('VNEID_NOT_FOUND', 'unknown transaction or wrong secret');
  if (!isTransactionId(transactionId) || !isClientSecret(clientSecret)) throw notFound();
  const presented = hashClientSecret(clientSecret);
  const row = deps.store.get(transactionId);
  if (!row || !safeEqual(row.clientSecretHash, presented)) throw notFound();
  return row;
}

function viewOf(row: TransactionRow): StatusView {
  const base = {
    confirmDeadline: row.confirmDeadline,
    expiresAt: row.expiresAt,
    codeRequired: row.codeHash !== null,
  };
  switch (row.status) {
    case 'SUBMITTING':
    case 'PENDING':
      return { status: 'PENDING', ...base };
    case 'WAITING_USER':
    case 'SIGNED':
    case 'FINALIZED':
      return { status: row.status, ...base };
    case 'REJECTED':
      return { status: 'REJECTED', reason: 'REFUSED', ...base };
    case 'EXPIRED':
      return { status: 'EXPIRED', reason: 'TIMEOUT', ...base };
    case 'BURNED':
      return { status: 'FAILED', reason: 'CODE_ATTEMPTS', ...base };
    case 'FAILED':
      return {
        status: 'FAILED',
        reason: row.errorCode?.startsWith('DIAG_') ? 'SIGNATURE_UNUSABLE' : 'PROVIDER',
        ...base,
      };
  }
}

export async function getStatus(
  deps: VneidDeps,
  input: { transactionId: string; clientSecret: string }
): Promise<StatusView> {
  let row = authenticate(deps, input.transactionId, input.clientSecret);
  maintain(deps);
  const now = deps.now();
  const open = row.status === 'PENDING' || row.status === 'WAITING_USER';
  if (open && now > row.expiresAt) {
    deps.store.markEnded(row.id, 'EXPIRED', { errorCode: 'LOCAL_TIMEOUT' }, now);
  } else if (open) {
    // The webhook may not be configured (or reachable): ask CSign -- often
    // while the citizen can still act, then sparingly until expiry.
    const interval =
      now <= row.confirmDeadline + STATUS_POLL_GRACE_MS
        ? STATUS_CHECK_INTERVAL_MS
        : LATE_STATUS_CHECK_INTERVAL_MS;
    await refreshFromCsign(deps, row, interval);
  }
  row = deps.store.get(row.id) ?? row;
  return viewOf(row);
}

// ---- finalizeSigning --------------------------------------------------------------------

export interface FinalizeInput {
  transactionId: string;
  clientSecret: string;
  /** The confirmation code from VNeID, when codes are on. */
  code?: string | undefined;
}

/** Checks everything that does not need the PDF, so the route can refuse
 * before reading the body; returns the exact length the body must have. */
export function authorizeFinalize(
  deps: VneidDeps,
  input: FinalizeInput
): { originalLength: number } {
  const row = authenticate(deps, input.transactionId, input.clientSecret);
  if (row.status !== 'SIGNED' && row.status !== 'FINALIZED') {
    throw new VneidError('VNEID_NOT_READY', `transaction is ${row.status}`);
  }
  if (row.codeHash) {
    const code = (input.code ?? '').trim().toUpperCase();
    const matches =
      CODE_PATTERN.test(code) && safeEqual(row.codeHash, codeHash(deps.keys, row.id, code));
    if (!matches) {
      const result = deps.store.recordCodeFailure(row.id, MAX_CODE_ATTEMPTS, deps.now());
      throw new VneidError('VNEID_CODE_INVALID', 'wrong confirmation code', {
        detail: { burned: result === 'burned' },
      });
    }
  }
  if (row.finalizeCount >= MAX_FINALIZE_PER_TRANSACTION) {
    throw new VneidError('VNEID_FINALIZE_LIMIT', 'finalize attempts exhausted');
  }
  return { originalLength: row.originalLength };
}

/** A signature no longer verifies mathematically (trust aside). */
const isBroken = (entry: DetailedVerificationResult) =>
  entry.result.status === 'SIGNATURE_INVALID' ||
  entry.result.status === 'CONTENT_DIGEST_MISMATCH' ||
  entry.result.contentIntact === false;

/**
 * The finished file must hold every signature the original had, none of them
 * broken by the update, plus ours, valid and covering the whole file. Old
 * signatures are compared with their own state in the original (their trust
 * may legitimately be anything); network-dependent checks never decide.
 */
async function checkSignedFile(
  deps: VneidDeps,
  row: TransactionRow,
  original: Buffer,
  signed: Buffer,
  chain: OpenedChain
): Promise<void> {
  // A root outside the national store is added for this check only, so the
  // chain and the maths are still verified end to end.
  const trustStore = chain.rootTrusted
    ? deps.trustStore
    : withPinnedRoot(deps.trustStore, chain.rootDer);
  const before = await verifyPdfSignaturesDetailed(original, trustStore);
  const after = await verifyPdfSignaturesDetailed(signed, trustStore);
  const fail = (reason: string, detail: VneidLogDetail = {}) =>
    new VneidError('VNEID_SELF_CHECK_FAILED', reason, {
      detail: { transactionId: row.id, ...detail },
    });
  if (after.length !== before.length + 1) {
    throw fail('signature count changed', { before: before.length, after: after.length });
  }
  before.forEach((entry, index) => {
    if (!isBroken(entry) && isBroken(after[index]!)) {
      throw fail('an existing signature broke', {
        position: index + 1,
        status: after[index]!.result.status,
      });
    }
  });
  const added = after[after.length - 1]!;
  // A verified chain to a national root must come out fully valid; otherwise
  // only the trust verdict may fall short -- never the signature maths.
  const acceptable =
    chain.rootTrusted && chain.chainVerified
      ? added.result.status === 'SIGNED_VALID'
      : TRUST_ONLY_STATUSES.has(added.result.status);
  if (!acceptable || added.result.contentIntact !== true) {
    throw fail('the new signature does not verify', { status: added.result.status });
  }
}

/** Statuses that only say the root is not recognised -- the signature itself is fine. */
const TRUST_ONLY_STATUSES = new Set([
  'SIGNED_VALID',
  'ROOT_NOT_TRUSTED',
  'CHAIN_VALIDATION_FAILED',
]);

// ---- certificate list (the user picks one before signing) ---------------------------

export type CredentialIssue =
  | 'NOT_ACTIVE'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'UID_MISMATCH'
  | 'KEY_UNSUPPORTED'
  | 'KEY_USAGE'
  | 'SERIAL_MISMATCH'
  | 'CHAIN_BROKEN'
  | 'MALFORMED';

/** What the browser may know about a certificate: never the holder's name. */
export interface CredentialView {
  credentialId: string;
  /** Common name of the issuing CA. */
  issuer: string | undefined;
  validFrom: string | undefined;
  validTo: string | undefined;
  keyBits: number | undefined;
  usable: boolean;
  reason?: CredentialIssue | undefined;
  /** The chain ends at a national root (false on the CSign UAT environment). */
  rootTrusted: boolean;
  /** The CA certificates CSign sent really issued this certificate. When
   * false the certificate can still sign, but the CA chain of the signed file
   * cannot be verified. */
  chainVerified: boolean;
  /** Which link check failed, when `chainVerified` is false. */
  chainIssue?: ChainCheck | undefined;
}

const ISSUE_OF: Record<CertPolicyFailure, CredentialIssue> = {
  NO_CREDENTIAL: 'MALFORMED',
  CERT_NOT_ACTIVE: 'NOT_ACTIVE',
  CERT_MALFORMED: 'MALFORMED',
  SERIAL_MISMATCH: 'SERIAL_MISMATCH',
  UID_MISMATCH: 'UID_MISMATCH',
  KEY_UNSUPPORTED: 'KEY_UNSUPPORTED',
  KEY_USAGE: 'KEY_USAGE',
  NOT_YET_VALID: 'NOT_YET_VALID',
  EXPIRED: 'EXPIRED',
  CHAIN_BROKEN: 'CHAIN_BROKEN',
  CHAIN_TOO_LONG: 'CHAIN_BROKEN',
};

/** The citizen's certificates with whether each can sign. Calls CSign
 * credentials/list only -- nothing is sent to the citizen's phone. */
export async function listCredentialsForCitizen(
  deps: VneidDeps,
  citizenPid: string
): Promise<CredentialView[]> {
  if (!isValidCitizenPid(citizenPid)) {
    throw new VneidError('VNEID_INVALID_INPUT', 'citizen id is not a valid CCCD number');
  }
  let credentials;
  try {
    credentials = await deps.csign.listCredentials(citizenPid);
  } catch (error) {
    throw startFailure(error).error;
  }
  if (credentials.length === 0) {
    throw new VneidError('VNEID_NO_CERTIFICATE', 'no certificate listed for this citizen');
  }
  const views = evaluateCredentials(credentials, citizenPid, {
    now: new Date(deps.now()),
    trustStore: deps.trustStore,
  }).map(({ credential, accepted, failure }): CredentialView => {
    if (accepted) {
      return {
        credentialId: accepted.credentialId,
        issuer: accepted.issuerCommonName,
        validFrom: accepted.validFrom.toISOString(),
        validTo: accepted.validTo.toISOString(),
        keyBits: credential.keyLength,
        usable: true,
        rootTrusted: accepted.rootTrusted,
        chainVerified: accepted.chainVerified,
        ...(accepted.chainIssue ? { chainIssue: accepted.chainIssue } : {}),
      };
    }
    // Why, for the server terminal (CA data and codes only, nothing personal).
    console.warn('[vneid:credentials] certificate not usable', {
      credentialId: credential.credentialId,
      failure: failure?.failure,
      ...failure?.detail,
    });
    const summary = summarizeCredential(credential);
    return {
      credentialId: credential.credentialId,
      issuer: summary.issuerCn,
      validFrom: summary.validFrom,
      validTo: summary.validTo,
      keyBits: summary.keyBits ?? credential.keyLength,
      usable: false,
      reason: failure ? ISSUE_OF[failure.failure] : 'MALFORMED',
      rootTrusted: false,
      chainVerified: false,
    };
  });
  // Usable first, then the one valid longest.
  return views.sort(
    (a, b) =>
      Number(b.usable) - Number(a.usable) || (b.validTo ?? '').localeCompare(a.validTo ?? '')
  );
}

/**
 * The signature's RFC 3161 timestamp: taken at the first finalize, which the
 * page starts as soon as it sees SIGNED (seconds after the citizen confirmed),
 * then kept so every later download carries the same time. A TSA that fails
 * never blocks the file: it is signed without a timestamp.
 */
async function timestampFor(
  deps: VneidDeps,
  row: TransactionRow,
  signature: Buffer
): Promise<Buffer | undefined> {
  if (row.timestampToken) return row.timestampToken;
  if (!deps.tsa) return undefined;
  try {
    const stamp = await deps.tsa(signature);
    deps.store.saveTimestamp(row.id, stamp.tokenDer, deps.now());
    // A concurrent finalize may have stored its token first: use that one.
    return deps.store.get(row.id)?.timestampToken ?? stamp.tokenDer;
  } catch (error) {
    console.warn('[vneid:tsa] no timestamp, signing without one', {
      transactionId: row.id,
      reason: error instanceof TsaError ? error.message : 'error',
    });
    return undefined;
  }
}

export async function finalizeSigning(
  deps: VneidDeps,
  input: FinalizeInput & { original: Buffer }
): Promise<Buffer> {
  const { originalLength } = authorizeFinalize(deps, input);
  if (
    input.original.length !== originalLength ||
    !safeEqual(sha256(input.original), deps.store.get(input.transactionId)!.originalSha256)
  ) {
    throw new VneidError('VNEID_DOCUMENT_MISMATCH', 'not the PDF that was prepared');
  }
  if (!deps.store.claimFinalize(input.transactionId, MAX_FINALIZE_PER_TRANSACTION)) {
    throw new VneidError('VNEID_FINALIZE_LIMIT', 'finalize attempts exhausted');
  }
  const row = deps.store.get(input.transactionId)!;
  const chain = openChain(deps, row);
  const prepared = openPrepared(deps, row);
  if (!row.signature) throw new VneidError('VNEID_NOT_READY', 'no signature stored');
  const signature = row.signature;
  const timestampToken = await timestampFor(deps, row, signature);

  const finalize = (token: Buffer | undefined) =>
    deps.pdf.finalize({
      original: input.original,
      tail: prepared.tail,
      byteRange: prepared.byteRange,
      contentsOffset: prepared.contentsOffset,
      contentsLength: prepared.contentsLength,
      contentDigest: prepared.contentDigest,
      signedAttrsDer: prepared.signedAttrsDer,
      certificateDer: chain.certificateDer,
      chainDer: chain.chainDer,
      signature,
      timestampToken: token,
      analysis: prepared.analysis,
      expected: prepared.expected,
    });

  let signed: Buffer;
  try {
    try {
      signed = await finalize(timestampToken);
    } catch (error) {
      // A token that does not fit (a request prepared before timestamps had
      // room) or cannot be used never costs the citizen the signed file.
      if (
        !timestampToken ||
        !isPdfSignError(error) ||
        (error.code !== 'SIGNATURE_TOO_LARGE' && error.code !== 'CMS_INVALID')
      ) {
        throw error;
      }
      console.warn('[vneid:tsa] timestamp not embedded, signing without it', {
        transactionId: row.id,
        pdfCode: error.code,
      });
      signed = await finalize(undefined);
    }
  } catch (error) {
    if (isPdfSignError(error)) {
      const code = error.code === 'JOB_BUSY' ? 'VNEID_BUSY' : 'VNEID_SELF_CHECK_FAILED';
      throw new VneidError(code, error.message, {
        detail: { transactionId: row.id, pdfCode: error.code },
      });
    }
    throw error;
  }
  await checkSignedFile(deps, row, input.original, signed, chain);
  deps.store.markFinalized(row.id, deps.now());
  return signed;
}
