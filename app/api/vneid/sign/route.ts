import { SignatureField, SignatureFieldValidationError } from '@/lib/domain/SignatureField';
import { MAX_PDF_BYTES } from '@/lib/pdfSign/limits';
import { isValidPdfUpload } from '@/lib/pdfValidation';
import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';
import { VneidError } from '@/lib/vneid/errors';
import {
  checkOrigin,
  declaredLength,
  documentedErrors,
  errorResponse,
  jsonResponse,
  type Language,
  languageOf,
  requireContentType,
  toIsoTime,
} from '@/lib/vneid/http';
import { getVneidDeps, startSigning } from '@/lib/vneid/service';
import { verifyTurnstile } from '@/lib/vneid/turnstile';

export const runtime = 'nodejs';

/** The PDF plus a few small fields and the multipart framing. */
const MAX_REQUEST_BYTES = MAX_PDF_BYTES + 512 * 1024;
const MAX_FIELDS_JSON_CHARS = 4096;
/** A certificate serial in hex, as credentials/list returns it. */
const CREDENTIAL_ID_PATTERN = /^[0-9A-Fa-f]{1,64}$/;

const ERRORS = documentedErrors([
  { error: 'VNEID_FORBIDDEN_ORIGIN' },
  { error: 'VNEID_UNSUPPORTED_MEDIA_TYPE' },
  { error: 'VNEID_LENGTH_REQUIRED' },
  { error: 'VNEID_PAYLOAD_TOO_LARGE' },
  { error: 'VNEID_CHALLENGE_FAILED' },
  { error: 'VNEID_NOT_CONFIGURED' },
  { error: 'VNEID_INVALID_INPUT' },
  { error: 'VNEID_PDF_REJECTED' },
  { error: 'VNEID_REQUEST_PENDING' },
  { error: 'VNEID_CITIZEN_LIMITED' },
  { error: 'VNEID_DAILY_CAP' },
  { error: 'VNEID_NO_CERTIFICATE' },
  { error: 'VNEID_CERT_INVALID' },

  { error: 'VNEID_BUSY' },
  { error: 'VNEID_UPSTREAM' },
  { error: 'VNEID_INTERNAL' },
]);

const invalid = (reason: string) => new VneidError('VNEID_INVALID_INPUT', reason);

/**
 * POST /api/vneid/sign (multipart: file, citizenPid, signatureFields, language).
 *
 * Starts a VNeID signing request: the PDF is checked and prepared, CSign sends
 * the citizen a notification in the VNeID app. Answers with the transaction id
 * and the client secret the browser keeps for /status and /finalize. Every
 * other identifier (requestId, documentId, digest...) is generated server-side.
 */
export async function POST(request: Request): Promise<Response> {
  const clientIp = clientIpFromRequest(request);
  const rateLimit = checkRateLimit(`vneid-sign:${clientIp}`, { limit: 30, windowMs: 10 * 60_000 });
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  let language: Language = languageOf(request);
  try {
    checkOrigin(request);
    requireContentType(request, 'multipart/form-data');
    declaredLength(request, MAX_REQUEST_BYTES);
    await verifyTurnstile(request, clientIp);
    const deps = getVneidDeps();

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw invalid('body is not readable multipart');
    }

    const languageField = form.get('language');
    if (languageField !== null && languageField !== 'vi' && languageField !== 'en') {
      throw invalid('language must be vi or en');
    }
    language = languageOf(request, languageField);

    const files = form.getAll('file');
    const file = files[0];
    if (files.length !== 1 || !(file instanceof File))
      throw invalid('exactly one file is required');
    if (file.size > MAX_PDF_BYTES) {
      throw new VneidError('VNEID_PAYLOAD_TOO_LARGE', 'PDF over the size limit');
    }
    const pdf = Buffer.from(await file.arrayBuffer());
    if (!isValidPdfUpload(pdf, file.name, file.type)) throw invalid('file is not a PDF');

    const citizenPid = form.get('citizenPid');
    if (typeof citizenPid !== 'string') throw invalid('citizenPid is required');

    // Optional: the certificate picked from /api/vneid/credentials (its serial).
    const credentialField = form.get('credentialId');
    if (
      credentialField !== null &&
      (typeof credentialField !== 'string' || !CREDENTIAL_ID_PATTERN.test(credentialField))
    ) {
      throw invalid('credentialId is malformed');
    }

    const fieldsJson = form.get('signatureFields');
    if (typeof fieldsJson !== 'string' || fieldsJson.length > MAX_FIELDS_JSON_CHARS) {
      throw invalid('signatureFields must be a JSON array');
    }
    let fieldsRaw: unknown;
    try {
      fieldsRaw = JSON.parse(fieldsJson);
    } catch {
      throw invalid('signatureFields must be a JSON array');
    }
    if (!Array.isArray(fieldsRaw)) throw invalid('signatureFields must be a JSON array');
    let fields;
    try {
      fields = SignatureField.createMany(fieldsRaw).map((field) => field.toPlacement());
    } catch (error) {
      if (error instanceof SignatureFieldValidationError) throw invalid(error.message);
      throw error;
    }

    const started = await startSigning(deps, {
      pdf,
      fields,
      citizenPid: citizenPid.trim(),
      language,
      clientIp,
      credentialId: credentialField ?? undefined,
    });
    return jsonResponse({
      transactionId: started.transactionId,
      clientSecret: started.clientSecret,
      confirmDeadline: toIsoTime(started.confirmDeadline),
      expiresAt: toIsoTime(started.expiresAt),
      codeRequired: started.codeRequired,
      documentName: started.documentName,
    });
  } catch (error) {
    return errorResponse(error, { route: 'sign', allowed: ERRORS, language });
  }
}
