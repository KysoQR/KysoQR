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
import { getVneidDeps, isValidCitizenPid, listCredentialsForCitizen } from '@/lib/vneid/service';

export const runtime = 'nodejs';

const MAX_BODY_BYTES = 1024;
const DAILY_LOOKUPS_KEY = 'vneid-day:credentials';

const ERRORS = documentedErrors([
  { error: 'VNEID_ACCESS_DENIED' },
  { error: 'VNEID_FORBIDDEN_ORIGIN' },
  { error: 'VNEID_UNSUPPORTED_MEDIA_TYPE' },
  { error: 'VNEID_LENGTH_REQUIRED' },
  { error: 'VNEID_PAYLOAD_TOO_LARGE' },
  { error: 'VNEID_NOT_CONFIGURED' },
  { error: 'VNEID_INVALID_INPUT' },
  { error: 'VNEID_NO_CERTIFICATE' },
  { error: 'VNEID_DAILY_CAP' },
  { error: 'VNEID_UPSTREAM' },
  { error: 'VNEID_INTERNAL' },
]);

/**
 * POST /api/vneid/credentials -- body `{ citizenPid }`.
 *
 * The citizen's certificates at CSign (credentials/list), each with whether
 * it can sign, so the user can pick one before signing. Nothing is sent to
 * the citizen's phone. Never returns the holder's name or the CCCD: anyone
 * can type any number here, so the answer must not turn into a lookup of
 * who owns it.
 */
export async function POST(request: Request): Promise<Response> {
  // Only clients in VNEID_TRUSTED_IPS (when set) may use VNeID at all.
  const denied = vneidAccessDenied(request);
  if (denied) return denied;
  const tooFast = perSecondLimit('credentials', clientIpFromRequest(request));
  if (tooFast) return tooFast;
  const rateLimit = checkRateLimit(`vneid-credentials:${clientIpFromRequest(request)}`, {
    limit: 20,
    windowMs: 10 * 60_000,
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

    // Per citizen as well, so one number cannot be probed from many addresses.
    const perCitizen = checkRateLimit(
      `vneid-credentials-citizen:${citizenKey(deps.keys, citizenPid.trim())}`,
      { limit: 10, windowMs: 10 * 60_000 }
    );
    if (!perCitizen.allowed) return rateLimitedResponse(perCitizen.retryAfterSeconds);

    // Service-wide daily cap on lookups (each is a CSign call). Kept in
    // memory: it starts again from zero when the server restarts.
    const daily = checkRateLimit(DAILY_LOOKUPS_KEY, {
      limit: deps.config.dailyCap,
      windowMs: 24 * 60 * 60_000,
    });
    if (!daily.allowed) {
      throw new VneidError('VNEID_DAILY_CAP', 'daily cap of certificate lookups reached', {
        retryAfterSeconds: daily.retryAfterSeconds,
      });
    }

    const credentials = await listCredentialsForCitizen(deps, citizenPid.trim());
    return jsonResponse({ credentials });
  } catch (error) {
    return errorResponse(error, { route: 'credentials', allowed: ERRORS, language });
  }
}
