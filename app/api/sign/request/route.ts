import { randomUUID } from 'node:crypto';
import { CasESignError, sanitizeLogText } from '@/lib/cas/CasEsignProvider';
import { getCasProvider } from '@/lib/cas/getCasProvider';
import { isTimeoutError } from '@/lib/fetchWithTimeout';
import { casErrorDetail } from '@/lib/casErrorDetail';
import { CAS_MAX_FILE_BYTES, normalizeDocumentName } from '@/lib/documentName';
import { isValidPdfUpload } from '@/lib/pdfValidation';
import { SignatureField, SignatureFieldValidationError } from '@/lib/domain/SignatureField';
import {
  CasSignerConfig,
  CasSignerConfigValidationError,
  type SignerType,
} from '@/lib/domain/CasSignerConfig';
import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';

export const runtime = 'nodejs';

function badRequest(code: string, message: string): Response {
  return Response.json({ error: code, message }, { status: 400 });
}

/** Server-side visibility into a failed CAS submit -- the client only ever
 * gets a short, user-facing message (see the catch block below), so without
 * this the real cause (CAS's status/errorCode/requestId, or a non-CAS
 * exception) would never show up anywhere, not even as more than a bare
 * "502" in the request-timing log line. `sanitizeLogText` strips anything
 * that looks like a CCCD/MST/phone number out of the free-text message
 * before it reaches the log. */
function logCasSubmitError(error: unknown): void {
  if (error instanceof CasESignError) {
    console.error('[sign:request] CAS submit failed', {
      status: error.status,
      errorCode: error.errorCode,
      errorType: error.errorType,
      casRequestId: error.casRequestId,
      message: sanitizeLogText(error.message),
    });
    return;
  }
  console.error(
    '[sign:request] CAS submit failed',
    sanitizeLogText(error instanceof Error ? error.message : String(error))
  );
}

/**
 * POST /api/sign/request.
 *
 * Stateless: everything CAS needs is sent in this one call, nothing is
 * written to disk. Validates the upload, normalizes documentName, rejects
 * >10MB before ever calling CAS, generates `signRequestId` here (not CAS),
 * and falls back to QR-only once if a supplied CCCD isn't a registered
 * Cas ID user.
 */
export async function POST(request: Request): Promise<Response> {
  const rateLimit = checkRateLimit(`sign-request:${clientIpFromRequest(request)}`, {
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
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!isValidPdfUpload(buffer, file.name, file.type)) {
    return badRequest('INVALID_PDF', 'Uploaded file is not a valid PDF');
  }
  if (buffer.byteLength > CAS_MAX_FILE_BYTES) {
    return badRequest('DOCUMENT_TOO_LARGE_FOR_CAS', 'File exceeds the 10MB limit CAS enforces');
  }

  let signatureFieldsRaw: unknown;
  try {
    signatureFieldsRaw = JSON.parse(String(form.get('signatureFields') ?? '[]'));
  } catch {
    return badRequest('INVALID_SIGNATURE_FIELDS', 'signatureFields must be a JSON array');
  }
  if (!Array.isArray(signatureFieldsRaw)) {
    return badRequest('INVALID_SIGNATURE_FIELDS', 'signatureFields must be a JSON array');
  }

  let signatureFields;
  try {
    signatureFields = SignatureField.createMany(signatureFieldsRaw);
  } catch (error) {
    if (error instanceof SignatureFieldValidationError) {
      return badRequest('INVALID_SIGNATURE_FIELDS', error.message);
    }
    throw error;
  }

  const signerTypeRaw = form.get('signerType') || 'individual';
  if (signerTypeRaw !== 'individual' && signerTypeRaw !== 'enterprise') {
    return badRequest(
      'INVALID_SIGNER_CONFIG',
      'signerType must be "individual" or "enterprise"'
    );
  }
  const signerType: SignerType = signerTypeRaw;

  const languageRaw = form.get('language') || 'vi';
  if (languageRaw !== 'vi' && languageRaw !== 'en') {
    return badRequest('INVALID_LANGUAGE', 'language must be "vi" or "en"');
  }
  const language: 'vi' | 'en' = languageRaw;

  let signerConfig: CasSignerConfig;
  try {
    signerConfig = CasSignerConfig.create({
      signerType,
      identificationNumber: form.get('identificationNumber') as string | null,
      taxCode: form.get('taxCode') as string | null,
      organizationName: form.get('organizationName') as string | null,
      representativeName: form.get('representativeName') as string | null,
    });
  } catch (error) {
    if (error instanceof CasSignerConfigValidationError) {
      return badRequest('INVALID_SIGNER_CONFIG', error.message);
    }
    throw error;
  }

  const documentName = normalizeDocumentName(file.name.replace(/\.pdf$/i, ''));

  let casProvider;
  try {
    casProvider = getCasProvider();
  } catch (error) {
    // Config error (e.g. a required CAS_ESIGN_* var missing on the deploy target --
    // the Cloudflare "Runtime" vs "Builds" env-var tab mixup is the classic
    // cause, see docs/DEPLOY_CLOUDFLARE.md). This used to throw straight out
    // of the route handler as an opaque 500 with no JSON body -- the client
    // couldn't tell this apart from a real network/CAS failure.
    console.error(
      '[sign:request] CAS provider unavailable',
      sanitizeLogText(error instanceof Error ? error.message : String(error))
    );
    return Response.json(
      {
        error: 'CAS_NOT_CONFIGURED',
        message: 'Máy chủ chưa được cấu hình đầy đủ để ký số. Vui lòng liên hệ quản trị viên.',
      },
      { status: 500 }
    );
  }
  const signRequestId = randomUUID();
  const shared = {
    signRequestId,
    signatureFields: signatureFields.map((field) => field.toCasConvention()),
    documentName,
    organizationName: signerConfig.organizationName,
    taxCode: signerConfig.taxCodeForSubmission(),
    language,
    file: { buffer, filename: `${documentName}.pdf`, contentType: 'application/pdf' },
  };

  const identificationNumber = signerConfig.identificationNumber;
  let submitted;
  try {
    if (identificationNumber) {
      try {
        submitted = await casProvider.submitDocument({ ...shared, identificationNumber });
      } catch (error) {
        // A rejected submit never consumed the id (CAS validates the signer
        // before committing it) — safe to retry QR-only with the same id.
        if (!casProvider.isPersonNotFoundError(error)) throw error;
        submitted = await casProvider.submitDocument(shared);
      }
    } else {
      submitted = await casProvider.submitDocument(shared);
    }
  } catch (error) {
    if (casProvider.isRateLimitedError(error)) {
      return Response.json(
        { error: 'CAS_RATE_LIMITED', message: 'CAS is rate-limiting this client' },
        { status: 429 }
      );
    }
    if (casProvider.isCertificateNotFoundError(error)) {
      logCasSubmitError(error);
      return Response.json(
        {
          error: 'CAS_CERTIFICATE_NOT_FOUND',
          message: 'Không tìm thấy thông tin người dùng bên CAS.',
          detail: casErrorDetail(error),
        },
        { status: 502 }
      );
    }
    // Any other CAS failure (e.g. APP_NOT_PERMITTED_ACCESS -- a CAS
    // credential/config problem, nothing the end user caused or can fix) --
    // the raw CasESignError message is an internal, English, code-carrying
    // string never meant for an end user to read. It's still fully captured
    // by logCasSubmitError above for whoever needs to actually diagnose it,
    // AND (via `detail`) reaches the client too now, so opening DevTools on
    // a real deploy shows the same thing the server terminal would -- the
    // client only ever displays the generic `message`, though.
    logCasSubmitError(error);
    return Response.json(
      {
        error: 'CAS_SUBMIT_FAILED',
        message: isTimeoutError(error)
          ? 'CAS không phản hồi kịp thời. Vui lòng thử lại sau.'
          : 'Không thể gửi yêu cầu ký. Vui lòng thử lại sau.',
        detail: casErrorDetail(error),
      },
      { status: 502 }
    );
  }

  return Response.json({
    signRequestId: submitted.signRequestId,
    qrContent: submitted.qrContent,
    state: submitted.state,
  });
}
