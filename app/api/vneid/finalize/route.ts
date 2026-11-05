import { MAX_PDF_BYTES } from '@/lib/pdfSign/limits';
import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';
import { VneidError } from '@/lib/vneid/errors';
import {
  bearerSecret,
  checkOrigin,
  declaredLength,
  documentedErrors,
  errorResponse,
  languageOf,
  readBody,
  requireContentType,
  SECURITY_HEADERS,
} from '@/lib/vneid/http';
import { authorizeFinalize, finalizeSigning, getVneidDeps } from '@/lib/vneid/service';

export const runtime = 'nodejs';

const ERRORS = documentedErrors([
  { error: 'VNEID_FORBIDDEN_ORIGIN' },
  { error: 'VNEID_UNSUPPORTED_MEDIA_TYPE' },
  { error: 'VNEID_LENGTH_REQUIRED' },
  { error: 'VNEID_PAYLOAD_TOO_LARGE' },
  { error: 'VNEID_NOT_CONFIGURED' },
  { error: 'VNEID_NOT_FOUND' },
  { error: 'VNEID_NOT_READY' },
  { error: 'VNEID_CODE_INVALID' },
  { error: 'VNEID_DOCUMENT_MISMATCH' },
  { error: 'VNEID_FINALIZE_LIMIT' },
  { error: 'VNEID_BUSY' },
  { error: 'VNEID_SELF_CHECK_FAILED' },
  { error: 'VNEID_INTERNAL' },
]);

/**
 * POST /api/vneid/finalize -- body: the ORIGINAL PDF (application/pdf, raw);
 * headers `x-vneid-tx: <transactionId>`, `Authorization: Bearer <clientSecret>`
 * and, when codes are on, `x-vneid-code`.
 *
 * Everything that does not need the PDF is checked before the body is read;
 * the body must be exactly the file that was prepared (length + SHA-256).
 * Returns the signed PDF once it passed the final check.
 */
export async function POST(request: Request): Promise<Response> {
  const rateLimit = checkRateLimit(`vneid-finalize:${clientIpFromRequest(request)}`, {
    limit: 30,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  const language = languageOf(request);
  try {
    checkOrigin(request);
    requireContentType(request, 'application/pdf');
    const length = declaredLength(request, MAX_PDF_BYTES);
    const deps = getVneidDeps();

    const ticket = {
      transactionId: request.headers.get('x-vneid-tx') ?? '',
      clientSecret: bearerSecret(request),
      code: request.headers.get('x-vneid-code') ?? undefined,
    };
    const { originalLength } = authorizeFinalize(deps, ticket);
    if (length !== originalLength) {
      throw new VneidError('VNEID_DOCUMENT_MISMATCH', 'length differs from the prepared file');
    }
    const original = await readBody(request, originalLength);
    const signed = await finalizeSigning(deps, { ...ticket, original });

    return new Response(new Uint8Array(signed), {
      status: 200,
      headers: {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/pdf',
        'Content-Length': String(signed.length),
        'Content-Disposition': `attachment; filename="kysoqr-vneid-${ticket.transactionId}.pdf"`,
        'Content-Security-Policy': 'sandbox',
      },
    });
  } catch (error) {
    return errorResponse(error, { route: 'finalize', allowed: ERRORS, language });
  }
}
