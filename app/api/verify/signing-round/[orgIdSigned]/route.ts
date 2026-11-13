import { getCasProvider } from '@/lib/cas/getCasProvider';
import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';
import { isTimeoutError } from '@/lib/fetchWithTimeout';
import { casErrorDetail } from '@/lib/casErrorDetail';
import { isLookupCode, signingRoundView } from '@/lib/signingRoundView';

export const runtime = 'nodejs';

/**
 * GET /api/verify/signing-round/[orgIdSigned].
 *
 * Convenience lookup (trusts CAS's own record, not a cryptographic
 * verification — must be presented to the user as lighter/different from
 * /api/verify/upload). `orgIdSigned` is opaque and may include a display
 * prefix (e.g. `kysoqr.com#3bLzsA`) — CAS only uses the part after `#` for
 * the actual lookup, so it's forwarded as-is, URL-encoded.
 *
 * Public by nature (the code is printed on the signed PDF), so: only codes of
 * the right shape reach CAS, each IP gets a few lookups per minute and per
 * hour (guessing codes needs many), and the answer is rebuilt by
 * signingRoundView -- citizen ID masked to its last 4 digits, device reduced
 * to its model, nothing CAS adds later passes through unchecked.
 */
const NO_STORE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
export async function GET(
  request: Request,
  { params }: { params: Promise<{ orgIdSigned: string }> }
): Promise<Response> {
  const { orgIdSigned } = await params;

  const ip = clientIpFromRequest(request);
  for (const [key, limit, windowMs] of [
    [`verify-signing-round:${ip}`, 10, 60_000],
    [`verify-signing-round-hour:${ip}`, 60, 60 * 60_000],
  ] as const) {
    const rateLimit = checkRateLimit(key, { limit, windowMs });
    if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);
  }

  // Next hands the segment over decoded; a still-encoded one (`%23`) is
  // decoded once here. A malformed or bare code never reaches CAS.
  let code = orgIdSigned;
  if (!isLookupCode(code)) {
    try {
      code = decodeURIComponent(code);
    } catch {
      // not percent-encoding: checked as is below
    }
  }
  if (!isLookupCode(code)) return Response.json({ signingRound: null }, { headers: NO_STORE });

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
    const { signingRound } = await casProvider.getSigningRound(code);
    return Response.json(
      { signingRound: signingRound ? signingRoundView(signingRound) : null },
      { headers: NO_STORE }
    );
  } catch (error) {
    if (casProvider.isSigningRoundNotFoundError(error)) {
      // Not an error from the caller's point of view: the round simply isn't
      // completed yet (or the code is wrong) — same 200 shape as "not found".
      return Response.json({ signingRound: null }, { headers: NO_STORE });
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
