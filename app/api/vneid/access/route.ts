import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';
import { isVneidClientAllowed } from '@/lib/vneid/access';
import { jsonResponse, perSecondLimit } from '@/lib/vneid/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/vneid/access -- `{ allowed }`: whether this client may use VNeID
 * (VNEID_TRUSTED_IPS). The pages ask it to show or hide every VNeID control;
 * the other VNeID routes refuse an untrusted client by themselves anyway.
 */
export async function GET(request: Request): Promise<Response> {
  const clientIp = clientIpFromRequest(request);
  const tooFast = perSecondLimit('access', clientIp);
  if (tooFast) return tooFast;
  const rateLimit = checkRateLimit(`vneid-access:${clientIp}`, { limit: 60, windowMs: 60_000 });
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);
  return jsonResponse({ allowed: isVneidClientAllowed(request.headers) });
}
