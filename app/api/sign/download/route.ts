import { getCasProvider } from '@/lib/cas/getCasProvider';
import { isTimeoutError } from '@/lib/fetchWithTimeout';
import { casErrorDetail } from '@/lib/casErrorDetail';
import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';

export const runtime = 'nodejs';

/**
 * GET /api/sign/download?identityKey=...
 * IMPORTANT: takes `identityKey` (from a COMPLETED /api/sign/status
 * response), NOT `signRequestId` — CAS's download-file only accepts
 * identityKey. Streams the PDF straight back, never cached server-side.
 */
export async function GET(request: Request): Promise<Response> {
  const rateLimit = checkRateLimit(`sign-download:${clientIpFromRequest(request)}`, {
    limit: 20,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  const identityKey = new URL(request.url).searchParams.get('identityKey');
  if (!identityKey) {
    return Response.json(
      { error: 'MISSING_IDENTITY_KEY', message: 'identityKey query param is required' },
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
      '[sign:download] CAS provider unavailable',
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
    const result = await casProvider.downloadFile(identityKey);
    return new Response(Buffer.from(result.bytes), {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Content-Disposition': 'attachment; filename="signed.pdf"',
      },
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
      '[sign:download] CAS download failed',
      error instanceof Error ? error.message : String(error)
    );
    return Response.json(
      {
        error: 'CAS_DOWNLOAD_FAILED',
        message: isTimeoutError(error)
          ? 'CAS không phản hồi kịp thời. Vui lòng thử lại sau.'
          : 'Không thể tải file đã ký. Vui lòng thử lại sau.',
        detail: casErrorDetail(error),
      },
      { status: 502 }
    );
  }
}
