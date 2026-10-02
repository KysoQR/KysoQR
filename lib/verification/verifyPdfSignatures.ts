import type { TrustStore } from '../trustStore/TrustStore';
import { parseCertificateInfo } from './certParser';
import { parseCmsMessage } from './cmsAsn1';
import { type ChainCertInfo, verifyCertificateChainFromCmsBuffer } from './certChainVerifier';
import { verifyPdfContentDigest } from './pdfContentDigestVerifier';
import {
  type ExtractCmsSuccess,
  extractAllCmsFromSignedPdf,
  isLastSignatureCoveringWholeFile,
} from './pdfSignatureExtractor';
import { verifySignerInfoSignature } from './signatureVerifier';
import { extractSigningTimeFromCms } from './signingTimeExtraction';

export type VerificationStatus =
  | 'SIGNED_VALID'
  | 'CONTENT_DIGEST_MISMATCH'
  | 'CHAIN_VALIDATION_FAILED'
  | 'ROOT_NOT_TRUSTED'
  | 'SIGNATURE_INVALID'
  | 'TRUST_STORE_NOT_CONFIGURED'
  | 'UNSUPPORTED_SUBFILTER'
  | 'UNSUPPORTED_ALGORITHM';

export interface VerificationCertificate {
  subject: string;
  issuer: string;
  serialNumber: string;
  validFrom: string;
  validTo: string;
}

/** Verification outcome for one CMS signature/revision inside a PDF. */
export interface VerificationResult {
  status: VerificationStatus;
  message: string;
  signedAt?: string | undefined;
  certificate?: VerificationCertificate | undefined;
  certificateChain?: ChainCertInfo[] | undefined;
  certificateChainRootNotInTrustStore?: boolean | undefined;
  /** Informational only -- does not affect `status`. A signature stays
   * SIGNED_VALID forever once its certificate was valid AT SIGNING TIME;
   * this just tells the UI the certificate has since expired as of "now". */
  certificateExpiredNow?: boolean | undefined;
  contentIntact?: boolean | undefined;
  /** 1-based position of this signature in the file (oldest = 1). */
  position?: number | undefined;
}

/** Technical "why" behind a non-valid verdict, for the server log only --
 * never sent to the client. */
export type VerificationLogDetail = Record<string, string | number | boolean | number[] | undefined>;

export interface DetailedVerificationResult {
  result: VerificationResult;
  detail?: VerificationLogDetail | undefined;
}

function toVerificationCertificate(
  cert: import('node-forge').pki.Certificate
): VerificationCertificate {
  const parsed = parseCertificateInfo(cert);
  return {
    subject: parsed.subjectFull,
    issuer: parsed.issuerFull,
    serialNumber: parsed.serialNumber,
    validFrom: parsed.validFrom.toISOString(),
    validTo: parsed.validTo.toISOString(),
  };
}

async function verifyOneSignature(
  pdfBytes: Buffer,
  extracted: ExtractCmsSuccess,
  trustStore: TrustStore,
  wholeFileCovered: boolean
): Promise<DetailedVerificationResult> {
  const { cmsDer, byteRange, dictSigningTime } = extracted;

  const sigCheck = verifySignerInfoSignature(cmsDer, pdfBytes, byteRange);
  const certificate = sigCheck.leafCertificate
    ? toVerificationCertificate(sigCheck.leafCertificate)
    : undefined;

  let signedAt = dictSigningTime;
  try {
    signedAt = extractSigningTimeFromCms(parseCmsMessage(cmsDer)) ?? dictSigningTime;
  } catch {
    // keep dictSigningTime fallback
  }

  if (!sigCheck.ok && sigCheck.reason === 'UNSUPPORTED_KEY_ALGORITHM') {
    return {
      result: {
        status: 'UNSUPPORTED_ALGORITHM',
        message: `The signature uses an unsupported key algorithm (${sigCheck.keyAlgorithm ?? 'unknown'}).`,
        signedAt,
      },
      detail: { reason: sigCheck.reason, keyAlgorithm: sigCheck.keyAlgorithm },
    };
  }

  if (!sigCheck.ok) {
    return {
      result: {
        status: 'SIGNATURE_INVALID',
        message:
          'The signature could not be cryptographically verified against the signer’s certificate.',
        signedAt,
        certificate,
      },
      detail: { reason: sigCheck.reason, certSerial: certificate?.serialNumber },
    };
  }

  // Content-integrity check: the CMS messageDigest must match a fresh hash
  // of the actual signed byte ranges. `wholeFileCovered` is the PDF Shadow
  // Attack guard (only meaningful for the newest signature) -- unaccounted
  // trailing bytes after the last signed revision are treated the same as a
  // digest mismatch, since a viewer could render them as if they were part
  // of the signed content.
  const digestCheck = verifyPdfContentDigest(pdfBytes, cmsDer, byteRange);
  if (!digestCheck.ok || !wholeFileCovered) {
    return {
      result: {
        status: 'CONTENT_DIGEST_MISMATCH',
        message: 'The PDF content does not match what was actually signed.',
        signedAt,
        certificate,
        contentIntact: false,
      },
      detail: {
        // Which of the two checks failed: the signed bytes themselves were
        // changed, or extra bytes were appended after the newest signature.
        reason: digestCheck.ok ? 'BYTES_AFTER_LAST_SIGNATURE' : digestCheck.reason,
        byteRange: [...byteRange],
        signedEnd: byteRange[2] + byteRange[3],
        fileLength: pdfBytes.length,
        certSerial: certificate?.serialNumber,
      },
    };
  }

  if (!trustStore.isConfigured()) {
    return {
      result: {
        status: 'TRUST_STORE_NOT_CONFIGURED',
        message:
          'The server trust store is not configured; the certificate chain could not be anchored.',
        signedAt,
        certificate,
        contentIntact: true,
      },
      detail: { reason: 'TRUST_STORE_EMPTY' },
    };
  }

  const signedAtDate = signedAt ? new Date(signedAt) : undefined;
  const validityCheckDate =
    signedAtDate && !Number.isNaN(signedAtDate.getTime()) ? signedAtDate : undefined;
  const chainResult = await verifyCertificateChainFromCmsBuffer(
    cmsDer,
    trustStore,
    validityCheckDate
  );

  if (!chainResult) {
    return {
      result: {
        status: 'CHAIN_VALIDATION_FAILED',
        message: 'The PDF signature contains no valid certificate chain.',
        signedAt,
        certificate,
        contentIntact: true,
      },
      detail: { reason: 'NO_CERTIFICATE_CHAIN', certSerial: certificate?.serialNumber },
    };
  }

  if (!chainResult.valid) {
    if (chainResult.rootNotInTrustStore) {
      // The vulnerability this replaces: the legacy verifier treated this
      // exact case as still SIGNED_VALID. An untrusted root is now always
      // its own distinct, non-valid status.
      return {
        result: {
          status: 'ROOT_NOT_TRUSTED',
          message:
            'The signature and content are cryptographically valid, but the root CA is not in the trust store.',
          signedAt,
          certificate,
          certificateChain: chainResult.chain,
          certificateChainRootNotInTrustStore: true,
          certificateExpiredNow: chainResult.certificateExpiredNow,
          contentIntact: true,
        },
        detail: {
          reason: 'ROOT_NOT_IN_TRUST_STORE',
          rootIssuer: chainResult.chain[chainResult.chain.length - 1]?.issuer,
          certSerial: certificate?.serialNumber,
        },
      };
    }

    return {
      result: {
        status: 'CHAIN_VALIDATION_FAILED',
        message: chainResult.error ?? 'The signature certificate chain is invalid.',
        signedAt,
        certificate,
        certificateChain: chainResult.chain,
        contentIntact: true,
      },
      detail: {
        reason: 'CHAIN_INVALID',
        error: chainResult.error,
        chainLength: chainResult.chain.length,
        certSerial: certificate?.serialNumber,
      },
    };
  }

  return {
    result: {
      status: 'SIGNED_VALID',
      message: chainResult.certificateExpiredNow
        ? 'The signature was valid at signing time; the certificate has since expired.'
        : 'The signature, content, and certificate chain are all valid.',
      signedAt,
      certificate,
      certificateChain: chainResult.chain,
      certificateExpiredNow: chainResult.certificateExpiredNow,
      contentIntact: true,
    },
  };
}

/**
 * How many signatures are verified at the same time. Every signature in the
 * file IS verified (real contracts can carry many), but each one can fan out
 * into several outbound network calls (AIA intermediate-CA fetch + OCSP +
 * CRL, each SSRF-guarded but still real requests) -- running them all at
 * once would let a PDF stuffed with hundreds of signatures fire a burst of
 * outbound requests in one go. A small pool keeps that bounded.
 */
const VERIFY_CONCURRENCY = 4;

/** `Promise.all(items.map(fn))`, but with at most `limit` calls in flight;
 * results keep the input order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Verify every CMS signature embedded in a PDF, independent of any DB/CAS
 * lookup -- the real cryptographic verification entry point.
 *
 * Each signature is verified independently: an unexpected error while
 * processing one (e.g. a malformed embedded certificate) produces a
 * SIGNATURE_INVALID entry for that signature rather than failing the whole
 * request. An unsigned PDF returns an empty array (not an error).
 */
export async function verifyPdfSignatures(
  pdfBytes: Buffer,
  trustStore: TrustStore
): Promise<VerificationResult[]> {
  const detailed = await verifyPdfSignaturesDetailed(pdfBytes, trustStore);
  return detailed.map((entry) => entry.result);
}

/** Same as `verifyPdfSignatures`, plus a log-only `detail` per entry
 * explaining any non-valid verdict (see `VerificationLogDetail`). */
export async function verifyPdfSignaturesDetailed(
  pdfBytes: Buffer,
  trustStore: TrustStore
): Promise<DetailedVerificationResult[]> {
  const extraction = extractAllCmsFromSignedPdf(pdfBytes);
  if (!extraction.ok) {
    if (extraction.error.kind === 'NO_SIGNATURE_FIELD_FOUND') return [];
    return [
      {
        result: {
          status: 'SIGNATURE_INVALID',
          message: 'The PDF signature structure is malformed and could not be parsed.',
        },
        detail: { reason: extraction.error.kind },
      },
    ];
  }

  const all = extraction.values;

  // Coverage is judged on the newest entry of any kind (a PAdES-LTA
  // document timestamp usually is the newest one), but the verdict is
  // attached to the newest signature we actually verify, so bytes appended
  // after an unsupported last entry still get reported.
  const wholeFileCovered = isLastSignatureCoveringWholeFile(all, pdfBytes.length);
  let lastSupportedIndex = -1;
  all.forEach((value, index) => {
    if (value.supported) lastSupportedIndex = index;
  });

  return mapWithConcurrency(
    all,
    VERIFY_CONCURRENCY,
    async (value, index): Promise<DetailedVerificationResult> => {
      const verified: DetailedVerificationResult = value.supported
        ? await verifyOneSignature(
            pdfBytes,
            value,
            trustStore,
            index === lastSupportedIndex ? wholeFileCovered : true
          ).catch((error: unknown) => ({
            result: {
              status: 'SIGNATURE_INVALID',
              message: 'An unexpected error occurred while verifying this signature.',
            },
            detail: {
              reason: 'UNEXPECTED_ERROR',
              error: error instanceof Error ? error.message : String(error),
            },
          }))
        : { result: unsupportedSubFilterResult(value), detail: { subFilter: value.subFilter } };
      return { ...verified, result: { ...verified.result, position: index + 1 } };
    }
  );
}

/** One entry whose SubFilter this pipeline can't verify -- reported on its
 * own, without failing the other signatures in the document. */
function unsupportedSubFilterResult(value: ExtractCmsSuccess): VerificationResult {
  const isDocumentTimestamp = value.subFilter.toLowerCase() === 'etsi.rfc3161';
  return {
    status: 'UNSUPPORTED_SUBFILTER',
    message: isDocumentTimestamp
      ? 'Document timestamp (PAdES-LTA, ETSI.RFC3161): timestamps are not verified yet.'
      : `The PDF uses an unsupported digital signature format (${value.subFilter}).`,
    signedAt: value.dictSigningTime,
  };
}
