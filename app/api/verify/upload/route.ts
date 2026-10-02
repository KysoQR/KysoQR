import { MAX_UPLOAD_SIZE_MB } from '@/components/signing/constants';
import { isValidPdfUpload } from '@/lib/pdfValidation';
import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';
import { getTrustStore } from '@/lib/trustStore/getTrustStore';
import { sanitizeLogText } from '@/lib/cas/CasEsignProvider';
import {
  type DetailedVerificationResult,
  verifyPdfSignaturesDetailed,
} from '@/lib/verification/verifyPdfSignatures';

export const runtime = 'nodejs';

const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

function badRequest(code: string, message: string): Response {
  return Response.json({ error: code, message }, { status: 400 });
}

/** One server-log line per signature that is not SIGNED_VALID, with the
 * technical reason (`detail`) the client never sees. Signer names are left
 * out on purpose; the certificate serial is enough to identify the cert. */
function logVerificationProblems(entries: DetailedVerificationResult[], fileLength: number): void {
  for (const { result, detail } of entries) {
    if (result.status === 'SIGNED_VALID') continue;
    console.warn(`[verify:upload] signature #${result.position ?? '?'} -> ${result.status}`, {
      message: result.message,
      signedAt: result.signedAt,
      fileLength,
      ...detail,
    });
  }
}

/**
 * POST /api/verify/upload.
 *
 * The real cryptographic verification entry point: fully stateless, public,
 * no DB/CAS credential needed. For each CMS signature found in the uploaded
 * PDF, verifies `SignerInfo.signature` with the leaf cert's public key (the
 * fix for the original missing-crypto-check vulnerability), checks content
 * integrity (messageDigest + PDF Shadow Attack guard), and builds+verifies
 * the certificate chain against the bundled trust store at signing time.
 *
 * This route has no CAS/auth gate in front of it and is the heaviest-CPU
 * public route in the app, so the file-size cap is enforced here before any
 * parsing is attempted -- the client already rejects oversized files before
 * ever reaching the network, but that check can be bypassed by calling this
 * API directly.
 */
export async function POST(request: Request): Promise<Response> {
  const rateLimit = checkRateLimit(`verify-upload:${clientIpFromRequest(request)}`, {
    limit: 20,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest('INVALID_MULTIPART', 'Expected multipart/form-data body');
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return badRequest('NO_FILE_UPLOADED', 'Missing required "file" field');
  }

  if (file.size > MAX_UPLOAD_SIZE_BYTES) {
    return badRequest('FILE_TOO_LARGE', `File exceeds the ${MAX_UPLOAD_SIZE_MB}MB limit`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  if (!isValidPdfUpload(buffer, file.name, file.type)) {
    return badRequest('INVALID_PDF', 'Uploaded file is not a valid PDF');
  }

  try {
    const detailed = await verifyPdfSignaturesDetailed(buffer, getTrustStore());
    logVerificationProblems(detailed, buffer.length);
    return Response.json({ signatures: detailed.map((entry) => entry.result) });
  } catch (error) {
    // Fail closed: an unexpected error verifying an untrusted upload must
    // never be reported as "no signatures found" (which the UI treats as
    // silent/no-op) -- surface it as a hard failure instead.
    console.error(
      '[verify:upload] verification crashed:',
      sanitizeLogText(error instanceof Error ? (error.stack ?? error.message) : String(error))
    );
    return Response.json(
      { error: 'VERIFICATION_FAILED', message: 'Failed to verify the uploaded PDF' },
      { status: 500 }
    );
  }
}
