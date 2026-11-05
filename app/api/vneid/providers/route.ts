import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';
import { documentedErrors, errorResponse, jsonResponse, languageOf } from '@/lib/vneid/http';
import { listProviders } from '@/lib/vneid/registration';
import { getVneidDeps } from '@/lib/vneid/service';

export const runtime = 'nodejs';

const ERRORS = documentedErrors([
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
