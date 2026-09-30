import { getCasProvider } from '@/lib/cas/getCasProvider';
import { mapCasState } from '@/lib/mapCasState';
import { isTimeoutError } from '@/lib/fetchWithTimeout';
import { casErrorDetail } from '@/lib/casErrorDetail';
import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';

export const runtime = 'nodejs';

/**
 * GET /api/sign/status?signRequestId=... — stateless proxy to CAS's request-status. `orgIdSigned`/`expiresIn` are
 * forwarded as-is when present but are NOT guaranteed (unconfirmed against
 * CAS's official docs) — client must tolerate their absence.
 */
export async function GET(request: Request): Promise<Response> {
  const rateLimit = checkRateLimit(`sign-status:${clientIpFromRequest(request)}`, {
    limit: 60,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  const signRequestId = new URL(request.url).searchParams.get('signRequestId');
  if (!signRequestId) {
    return Response.json(
      { error: 'MISSING_SIGN_REQUEST_ID', message: 'signRequestId query param is required' },
      { status: 400 }
    );
  }

  let casProvider;
  try {
    casProvider = getCasProvider();
  } catch (error) {
    // Config error (e.g. a required CAS_ESIGN_* var missing on the deploy target) --
    // used to throw straight out of this handler as an opaque 500 with no
    // JSON body, indistinguishable from a real CAS/network failure.
    console.error(
      '[sign:status] CAS provider unavailable',
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
    const result = await casProvider.requestStatus(signRequestId);
    return Response.json({
      status: mapCasState(result.state),
      rawState: result.state,
      signedAt: result.signedAt,
      identityKey: result.identityKey ?? undefined,
      // Kept as `null` (not dropped) outside COMPLETED -- CAS documents it
      // as "set when state = COMPLETED, otherwise null".
      identityKeyExpiresAt: result.identityKeyExpiresAt,
      orgIdSigned: result.orgIdSigned ?? undefined,
      expiresIn: result.expiresIn ?? undefined,
    });
  } catch (error) {
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
      '[sign:status] CAS status check failed',
      error instanceof Error ? error.message : String(error)
    );
    return Response.json(
      {
        error: 'CAS_STATUS_FAILED',
        message: isTimeoutError(error)
          ? 'CAS không phản hồi kịp thời. Vui lòng thử lại sau.'
          : 'Không thể kiểm tra trạng thái ký. Vui lòng thử lại sau.',
        detail: casErrorDetail(error),
      },
      { status: 502 }
    );
  }
}
