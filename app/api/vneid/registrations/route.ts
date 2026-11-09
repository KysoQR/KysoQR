import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';
import { vneidAccessDenied } from '@/lib/vneid/access';
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
import { startRegistration } from '@/lib/vneid/registration';
import { getVneidDeps, isValidCitizenPid } from '@/lib/vneid/service';
import { verifyTurnstile } from '@/lib/vneid/turnstile';

export const runtime = 'nodejs';

/** CCCD, provider, pack and the form: a few hundred bytes. */
const MAX_BODY_BYTES = 8 * 1024;

const ERRORS = documentedErrors([
  { error: 'VNEID_ACCESS_DENIED' },
  { error: 'VNEID_FORBIDDEN_ORIGIN' },
  { error: 'VNEID_UNSUPPORTED_MEDIA_TYPE' },
  { error: 'VNEID_LENGTH_REQUIRED' },
  { error: 'VNEID_PAYLOAD_TOO_LARGE' },
  { error: 'VNEID_CHALLENGE_FAILED' },
  { error: 'VNEID_NOT_CONFIGURED' },
  { error: 'VNEID_INVALID_INPUT' },
  { error: 'VNEID_REGISTRATION_INVALID' },
  { error: 'VNEID_REGISTRATION_PENDING' },

  { error: 'VNEID_ALREADY_REGISTERED' },
  { error: 'VNEID_PROVIDER_UNAVAILABLE' },
  { error: 'VNEID_UPSTREAM' },
  { error: 'VNEID_INTERNAL' },
]);

/**
 * POST /api/vneid/registrations -- body `{ citizenPid, provider,
 * servicePackCode, userInfo }`.
 *
 * Registers a new certificate for a citizen who has none. CSign then asks the
 * citizen, on VNeID, to share their details and to activate the certificate;
 * the page follows with /api/vneid/registrations/status. The form goes to
 * CSign and nowhere else: it is neither stored nor logged nor sent back.
 */
export async function POST(request: Request): Promise<Response> {
  // Only clients in VNEID_TRUSTED_IPS (when set) may use VNeID at all.
  const denied = vneidAccessDenied(request);
  if (denied) return denied;
  const tooFast = perSecondLimit('registrations', clientIpFromRequest(request));
  if (tooFast) return tooFast;
  const clientIp = clientIpFromRequest(request);
  const rateLimit = checkRateLimit(`vneid-register:${clientIp}`, {
    limit: 5,
    windowMs: 10 * 60_000,
  });
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  const language = languageOf(request);
  try {
    checkOrigin(request);
    requireContentType(request, 'application/json');
    declaredLength(request, MAX_BODY_BYTES);
    await verifyTurnstile(request, clientIp);
    const deps = getVneidDeps();

    let body: { [key: string]: unknown } | null;
    try {
      body = JSON.parse((await readBody(request, MAX_BODY_BYTES)).toString('utf8')) as {
        [key: string]: unknown;
      } | null;
    } catch (error) {
      if (error instanceof VneidError) throw error;
      throw new VneidError('VNEID_INVALID_INPUT', 'body is not JSON');
    }
    const citizenPid = body?.citizenPid;
    if (typeof citizenPid !== 'string' || !isValidCitizenPid(citizenPid.trim())) {
      throw new VneidError('VNEID_INVALID_INPUT', 'citizenPid is not a valid CCCD number');
    }
    const registration = await startRegistration(deps, {
      citizenPid: citizenPid.trim(),
      provider: body?.provider,
      servicePackCode: body?.servicePackCode,
      servicePackName: body?.servicePackName,
      userInfo: body?.userInfo,
    });
    return jsonResponse({ registration }, 201);
  } catch (error) {
    return errorResponse(error, { route: 'register', allowed: ERRORS, language });
  }
}
