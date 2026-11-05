import { checkRateLimit, clientIpFromRequest, rateLimitedResponse } from '@/lib/rateLimit';
import { SECURITY_HEADERS } from '@/lib/vneid/http';
import { getVneidDeps, type VneidDeps } from '@/lib/vneid/service';
import { handleWebhook, MAX_WEBHOOK_BYTES } from '@/lib/vneid/webhook';

export const runtime = 'nodejs';

/** Answers in CSign's webhook format (`{ received }` / `{ error, errorDescription }`). */
function answer(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: SECURITY_HEADERS });
}

/**
 * POST /api/vneid/webhook -- called by CSign, not by browsers.
 *
 * Authenticated by the HMAC-SHA256 signature in `abp-webhook-signature`
 * (lib/vneid/webhook.ts does all checks). Register this URL at CSign with
 * the signing.created / signing.completed / signing.failed events only.
 */
export async function POST(request: Request): Promise<Response> {
  const rateLimit = checkRateLimit(`vneid-webhook:${clientIpFromRequest(request)}`, {
    limit: 300,
    windowMs: 60_000,
  });
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit.retryAfterSeconds);

  let deps: VneidDeps;
  try {
    deps = getVneidDeps();
  } catch {
    return answer(503, {
      error: 'not_configured',
      errorDescription: 'VNeID signing is not configured',
    });
  }

  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    return answer(400, {
      error: 'payload_too_large',
      errorDescription: 'Payload exceeds the accepted size',
    });
  }
  // Read at most one byte past the limit: handleWebhook refuses anything larger.
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(value);
      if (total > MAX_WEBHOOK_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  }

  const result = await handleWebhook(
    deps,
    Buffer.concat(chunks),
    request.headers.get('abp-webhook-signature')
  );
  return answer(result.status, result.body);
}
