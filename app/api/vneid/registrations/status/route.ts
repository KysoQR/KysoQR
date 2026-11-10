import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';
import { vneidAccessDenied } from '@/lib/vneid/access';
import { citizenKey } from '@/lib/vneid/crypto';
import { VneidError } from '@/lib/vneid/errors';
import {
  checkOrigin,
  declaredLength,
  documentedErrors,
  errorResponse,
  jsonResponse,
  languageOf,
  readBody,
  requireContentType,
  perSecondLimit,
} from '@/lib/vneid/http';
import { getRegistration } from '@/lib/vneid/registration';
import { getVneidDeps, isValidCitizenPid } from '@/lib/vneid/service';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 1024;

const ERRORS = documentedErrors([
  { error: 'VNEID_ACCESS_DENIED' },
  { error: 'VNEID_FORBIDDEN_ORIGIN' },
  { error: 'VNEID_UNSUPPORTED_MEDIA_TYPE' },
  { error: 'VNEID_LENGTH_REQUIRED' },
  { error: 'VNEID_PAYLOAD_TOO_LARGE' },
  { error: 'VNEID_NOT_CONFIGURED' },
  { error: 'VNEID_INVALID_INPUT' },
  { error: 'VNEID_INTERNAL' },
]);

/**
 * POST /api/vneid/registrations/status -- body `{ citizenPid }`.
 *
 * The citizen's certificate registration -- open, or finished in the last 24
 * hours -- or `null`. Looked up by CCCD, so the page finds it again after a
 * reload once the CCCD is typed. CSign is asked at most every few seconds per
 * registration; the page polls this. No name or other personal data out.
 */
export async function POST(request: Request): Promise<Response> {
  // Only clients in VNEID_TRUSTED_IPS (when set) may use VNeID at all.
  const denied = vneidAccessDenied(request);
  if (denied) return denied;
  const tooFast = perSecondLimit('registrations-status', clientIpFromRequest(request));
  if (tooFast) return tooFast;
  const rateLimit = checkRateLimit(`vneid-register-status:${clientIpFromRequest(request)}`, {
    limit: 60,
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
    const citizenPid = (body as { citizenPid?: unknown } | null)?.citizenPid;
    if (typeof citizenPid !== 'string' || !isValidCitizenPid(citizenPid.trim())) {
      throw new VneidError('VNEID_INVALID_INPUT', 'citizenPid is not a valid CCCD number');
    }
    const perCitizen = checkRateLimit(
      `vneid-register-status-citizen:${citizenKey(deps.keys, citizenPid.trim())}`,
      { limit: 30, windowMs: 60_000 }
    );
    if (!perCitizen.allowed) return rateLimitedResponse(perCitizen.retryAfterSeconds);

    return jsonResponse({ registration: await getRegistration(deps, citizenPid.trim()) });
  } catch (error) {
    return errorResponse(error, { route: 'register-status', allowed: ERRORS, language });
  }
}
