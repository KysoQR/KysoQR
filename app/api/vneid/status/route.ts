import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';
import { VneidError } from '@/lib/vneid/errors';
import {
  bearerSecret,
  checkOrigin,
  declaredLength,
  documentedErrors,
  errorResponse,
  jsonResponse,
  languageOf,
  readBody,
  requireContentType,
  toIsoTime,
} from '@/lib/vneid/http';
import { getStatus, getVneidDeps, isTransactionId } from '@/lib/vneid/service';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 2048;

const ERRORS = documentedErrors([
  { error: 'VNEID_FORBIDDEN_ORIGIN' },
  { error: 'VNEID_UNSUPPORTED_MEDIA_TYPE' },
  { error: 'VNEID_LENGTH_REQUIRED' },
  { error: 'VNEID_PAYLOAD_TOO_LARGE' },
  { error: 'VNEID_NOT_CONFIGURED' },
  { error: 'VNEID_INVALID_INPUT' },
  { error: 'VNEID_NOT_FOUND' },
  { error: 'VNEID_INTERNAL' },
]);

/**
 * POST /api/vneid/status -- body `{ transactionId }`, header
 * `Authorization: Bearer <clientSecret>`.
 *
 * Where a signing request stands. Read from the database; CSign is asked
 * (at most every 15 s per request) only while the citizen can still confirm.
 * Never returns the signature or anything personal.
 */
export async function POST(request: Request): Promise<Response> {
  const rateLimit = checkRateLimit(`vneid-status:${clientIpFromRequest(request)}`, {
    limit: 120,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  const language = languageOf(request);
  try {
    checkOrigin(request);
    requireContentType(request, 'application/json');
    declaredLength(request, MAX_BODY_BYTES);
    const deps = getVneidDeps();

    let body: unknown;
    try {
      body = JSON.parse((await readBody(request, MAX_BODY_BYTES)).toString('utf8'));
    } catch (error) {
      if (error instanceof VneidError) throw error;
      throw new VneidError('VNEID_INVALID_INPUT', 'body is not JSON');
    }
    const transactionId = (body as { transactionId?: unknown } | null)?.transactionId;
    if (typeof transactionId !== 'string' || !isTransactionId(transactionId)) {
      throw new VneidError('VNEID_NOT_FOUND', 'malformed transaction id');
    }

    // One misbehaving tab must not use up the whole IP budget of an office.
    const perTransaction = checkRateLimit(`vneid-status-tx:${transactionId}`, {
      limit: 30,
      windowMs: 60_000,
    });
    if (!perTransaction.allowed) return rateLimitedResponse(perTransaction.retryAfterSeconds);

    const view = await getStatus(deps, { transactionId, clientSecret: bearerSecret(request) });
    return jsonResponse({
      status: view.status,
      ...(view.reason ? { reason: view.reason } : {}),
      confirmDeadline: toIsoTime(view.confirmDeadline),
      expiresAt: toIsoTime(view.expiresAt),
      codeRequired: view.codeRequired,
    });
  } catch (error) {
    return errorResponse(error, { route: 'status', allowed: ERRORS, language });
  }
}
