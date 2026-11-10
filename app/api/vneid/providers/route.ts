import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';
import { vneidAccessDenied } from '@/lib/vneid/access';
import {
  documentedErrors,
  errorResponse,
  jsonResponse,
  languageOf,
  perSecondLimit,
} from '@/lib/vneid/http';
import { listProviders } from '@/lib/vneid/registration';
import { getVneidDeps } from '@/lib/vneid/service';

export const runtime = 'nodejs';

const ERRORS = documentedErrors([
  { error: 'VNEID_ACCESS_DENIED' },
  { error: 'VNEID_NOT_CONFIGURED' },
  { error: 'VNEID_UPSTREAM' },
  { error: 'VNEID_INTERNAL' },
]);

/**
 * GET /api/vneid/providers
 *
 * The certificate providers (CAs) CSign offers and their service packs --
 * paid ones too, with their price -- for a citizen who registers a new
 * certificate. Nothing personal in or out; CSign is asked at most every 10
 * minutes.
 */
export async function GET(request: Request): Promise<Response> {
  // Only clients in VNEID_TRUSTED_IPS (when set) may use VNeID at all.
  const denied = vneidAccessDenied(request);
  if (denied) return denied;
  const tooFast = perSecondLimit('providers', clientIpFromRequest(request));
  if (tooFast) return tooFast;
  const rateLimit = checkRateLimit(`vneid-providers:${clientIpFromRequest(request)}`, {
    limit: 30,
    windowMs: 10 * 60_000,
  });
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  const language = languageOf(request);
  try {
    return jsonResponse({ providers: await listProviders(getVneidDeps()) });
  } catch (error) {
    return errorResponse(error, { route: 'providers', allowed: ERRORS, language });
  }
}
