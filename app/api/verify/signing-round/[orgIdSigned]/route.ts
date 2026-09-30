import { getCasProvider } from '@/lib/cas/getCasProvider';
import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';
import { isTimeoutError } from '@/lib/fetchWithTimeout';
import { casErrorDetail } from '@/lib/casErrorDetail';

export const runtime = 'nodejs';

/**
 * GET /api/verify/signing-round/[orgIdSigned].
 *
 * Convenience lookup (trusts CAS's own record, not a cryptographic
 * verification — must be presented to the user as lighter/different from
 * /api/verify/upload). `orgIdSigned` is opaque and may include a display
 * prefix (e.g. `kysoqr.com#3bLzsA`) — CAS only uses the part after `#` for
 * the actual lookup, so it's forwarded as-is, URL-encoded.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgIdSigned: string }> }
): Promise<Response> {
  const { orgIdSigned } = await params;

  const rateLimit = checkRateLimit(`verify-signing-round:${clientIpFromRequest(request)}`, {
    limit: 30,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  let casProvider;
  try {
    casProvider = getCasProvider();
  } catch (error) {
    // Config error (e.g. a required CAS_ESIGN_* var missing on the deploy target) --
    // used to throw straight out of this handler as an opaque 500 with no
    // JSON body, indistinguishable from a real CAS/network failure.
    console.error(
      '[verify:signing-round] CAS provider unavailable',
      error instanceof Error ? error.message : String(error)
    );
    return Response.json(
      {
        error: 'CAS_NOT_CONFIGURED',
        message: 'Máy chủ chưa được cấu hình đầy đủ để ký số. Vui lòng liên hệ quản trị viên.',
      },
      { status: 500 }
    );
  }

  try {
    const result = await casProvider.getSigningRound(orgIdSigned);
    return Response.json(result);
  } catch (error) {
    if (casProvider.isSigningRoundNotFoundError(error)) {
      // Not an error from the caller's point of view: the round simply isn't
      // completed yet (or the code is wrong) — same 200 shape as "not found".
      return Response.json({ signingRound: null });
    }
    if (casProvider.isRateLimitedError(error)) {
      return Response.json(
        { error: 'CAS_RATE_LIMITED', message: 'CAS is rate-limiting this client' },
        { status: 429 }
      );
    }
    // Only ever showed up in the server terminal before -- `detail` now
    // carries the same CAS errorCode/status (or a timeout flag) to the
    // client too, so DevTools on a real deploy shows what the server log
    // shows.
    console.error(
      '[verify:signing-round] CAS lookup failed',
      error instanceof Error ? error.message : String(error)
    );
    return Response.json(
      {
        error: 'CAS_SIGNING_ROUND_FAILED',
        message: isTimeoutError(error)
          ? 'CAS không phản hồi kịp thời. Vui lòng thử lại sau.'
          : 'Không thể tra cứu phiên ký. Vui lòng thử lại sau.',
        detail: casErrorDetail(error),
      },
      { status: 502 }
    );
  }
}
