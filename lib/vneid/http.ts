import { sanitizeLogText } from '../cas/casPayload';
import { checkRateLimit, rateLimitedResponse } from '../rateLimit';
import { isVneidError, VneidError, type VneidErrorCode } from './errors';

/**
 * What the four /api/vneid routes share: request checks done before a body
 * is read, the security headers, and turning a VneidError into the JSON the
 * client gets -- `{ error, message }`, with `message` written here for the
 * user and the technical detail kept for the server log.
 *
 * Each route passes the list of codes it documents (public/openapi); any
 * other code is answered as VNEID_INTERNAL, so the documentation cannot fall
 * behind the code silently.
 */

export type Language = 'vi' | 'en';

const MESSAGES: Record<VneidErrorCode, { vi: string; en: string }> = {
  VNEID_NOT_CONFIGURED: {
    vi: 'Máy chủ chưa được cấu hình để ký bằng VNeID. Vui lòng liên hệ quản trị viên.',
    en: 'This server is not set up for VNeID signing. Please contact the administrator.',
  },
  VNEID_ACCESS_DENIED: {
    vi: 'Ký bằng VNeID chưa mở cho mạng của bạn.',
    en: 'VNeID signing is not available from your network.',
  },
  VNEID_FORBIDDEN_ORIGIN: {
    vi: 'Yêu cầu không đến từ trang KysoQR.',
    en: 'The request did not come from the KysoQR site.',
  },
  VNEID_CHALLENGE_FAILED: {
    vi: 'Không xác minh được bạn không phải máy. Vui lòng tải lại trang và thử lại.',
    en: 'We could not confirm you are not a bot. Please reload the page and try again.',
  },
  VNEID_LENGTH_REQUIRED: {
    vi: 'Yêu cầu thiếu độ dài nội dung.',
    en: 'The request has no Content-Length.',
  },
  VNEID_PAYLOAD_TOO_LARGE: {
    vi: 'File quá lớn. Ký bằng VNeID nhận file PDF tối đa 10MB.',
    en: 'The file is too large. VNeID signing accepts PDF files up to 10 MB.',
  },
  VNEID_UNSUPPORTED_MEDIA_TYPE: {
    vi: 'Định dạng yêu cầu không đúng.',
    en: 'Unsupported request format.',
  },
  VNEID_INVALID_INPUT: {
    vi: 'Thông tin gửi lên không hợp lệ. Vui lòng kiểm tra số CCCD, file PDF và vị trí ô ký.',
    en: 'Invalid input. Please check the CCCD number, the PDF file and the signature boxes.',
  },
  VNEID_PDF_REJECTED: {
    vi: 'Không thể ký file PDF này (file có mật khẩu, bị khoá chỉnh sửa, hỏng hoặc có cấu trúc không hỗ trợ).',
    en: 'This PDF cannot be signed (password-protected, locked against changes, damaged or unsupported).',
  },
  VNEID_REQUEST_PENDING: {
    vi: 'CCCD này đang có một yêu cầu ký chờ xác nhận trên VNeID. Hãy xác nhận hoặc chờ yêu cầu đó hết hạn rồi thử lại.',
    en: 'This CCCD already has a signing request waiting on VNeID. Confirm it or wait for it to expire, then try again.',
  },
  VNEID_CITIZEN_LIMITED: {
    vi: 'CCCD này có quá nhiều yêu cầu ký bị từ chối hoặc bỏ qua. Vui lòng thử lại sau.',
    en: 'Too many signing requests for this CCCD were refused or ignored. Please try again later.',
  },
  VNEID_DAILY_CAP: {
    vi: 'Hệ thống đã đạt giới hạn lượt VNeID trong ngày. Vui lòng thử lại sau.',
    en: 'The daily limit of VNeID requests has been reached. Please try again later.',
  },
  VNEID_NO_CERTIFICATE: {
    vi: 'Số CCCD này chưa có chứng thư số ký qua VNeID, hoặc số CCCD chưa đúng.',
    en: 'This CCCD has no VNeID signing certificate, or the number is wrong.',
  },
  VNEID_CERT_INVALID: {
    vi: 'Chứng thư số của CCCD này chưa kích hoạt, đã hết hạn hoặc không dùng được để ký.',
    en: 'The certificate for this CCCD is not activated, has expired or cannot be used for signing.',
  },
  VNEID_REGISTRATION_INVALID: {
    vi: 'Thông tin đăng ký chưa hợp lệ. Vui lòng kiểm tra lại các ô trong form.',
    en: 'The registration details are not valid. Please check the form.',
  },
  VNEID_REGISTRATION_PENDING: {
    vi: 'CCCD này đang có một yêu cầu chờ xử lý trên VNeID. Hãy hoàn tất hoặc chờ yêu cầu đó kết thúc rồi thử lại.',
    en: 'This CCCD already has a request waiting on VNeID. Finish it or wait for it to end, then try again.',
  },

  VNEID_ALREADY_REGISTERED: {
    vi: 'CCCD này đã có chứng thư miễn phí của nhà cung cấp này. Hãy chọn nhà cung cấp hoặc gói khác.',
    en: 'This CCCD already has this provider’s free certificate. Choose another provider or pack.',
  },
  VNEID_PROVIDER_UNAVAILABLE: {
    vi: 'Nhà cung cấp hoặc gói chứng thư này hiện không nhận đăng ký. Vui lòng chọn lựa chọn khác.',
    en: 'This provider or certificate pack is not taking registrations. Please choose another one.',
  },

  VNEID_BUSY: {
    vi: 'Máy chủ đang xử lý nhiều file. Vui lòng thử lại sau ít giây.',
    en: 'The server is busy with other files. Please try again in a few seconds.',
  },
  VNEID_UPSTREAM: {
    vi: 'Dịch vụ ký số VNeID đang không phản hồi đúng. Vui lòng thử lại sau.',
    en: 'The VNeID signing service is not responding properly. Please try again later.',
  },
  VNEID_NOT_FOUND: {
    vi: 'Không tìm thấy yêu cầu ký (có thể đã hết hạn).',
    en: 'Signing request not found (it may have expired).',
  },
  VNEID_NOT_READY: {
    vi: 'Yêu cầu ký chưa được xác nhận trên VNeID.',
    en: 'The signing request has not been confirmed on VNeID yet.',
  },
  VNEID_DOCUMENT_MISMATCH: {
    vi: 'File PDF gửi lên không phải file đã gửi ký.',
    en: 'This is not the PDF that was sent for signing.',
  },
  VNEID_FINALIZE_LIMIT: {
    vi: 'Đã tải file đã ký quá số lần cho phép. Vui lòng gửi yêu cầu ký mới.',
    en: 'The signed file was requested too many times. Please start a new signing request.',
  },
  VNEID_CODE_INVALID: {
    vi: 'Mã xác nhận không đúng.',
    en: 'Wrong confirmation code.',
  },
  VNEID_SELF_CHECK_FAILED: {
    vi: 'File sau khi ghép chữ ký không vượt qua bước kiểm tra nên không được trả về. Vui lòng thử lại hoặc liên hệ quản trị viên.',
    en: 'The signed file failed the final check and was not released. Please try again or contact the administrator.',
  },
  VNEID_INTERNAL: {
    vi: 'Có lỗi xảy ra trên máy chủ. Vui lòng thử lại sau.',
    en: 'Something went wrong on the server. Please try again later.',
  },
};

/** Sent with every VNeID answer: nothing is cached, sniffed or leaked onward. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return Response.json(body, { status, headers: { ...SECURITY_HEADERS, ...headers } });
}

/** The route's documented error codes, written as `{ error: '...' }` literals
 * so lib/openapi.test.ts can read them from the route file. */
export function documentedErrors(list: { error: VneidErrorCode }[]): ReadonlySet<VneidErrorCode> {
  return new Set(list.map((entry) => entry.error));
}

export function languageOf(request: Request, chosen?: unknown): Language {
  if (chosen === 'en' || chosen === 'vi') return chosen;
  return /^\s*en\b/i.test(request.headers.get('accept-language') ?? '') ? 'en' : 'vi';
}

/** Problems on our side or CSign's are logged as errors; the user's own as warnings. */
const LOGGED_AS_ERROR = new Set<VneidErrorCode>([
  'VNEID_NOT_CONFIGURED',
  'VNEID_UPSTREAM',
  'VNEID_SELF_CHECK_FAILED',
  'VNEID_INTERNAL',
]);
const LOGGED_AS_WARNING = new Set<VneidErrorCode>([
  'VNEID_PROVIDER_UNAVAILABLE',
  'VNEID_PDF_REJECTED',
  'VNEID_CERT_INVALID',
  'VNEID_NO_CERTIFICATE',
  'VNEID_BUSY',
  'VNEID_CHALLENGE_FAILED',
  'VNEID_CODE_INVALID',
  'VNEID_DOCUMENT_MISMATCH',
]);

export function errorResponse(
  error: unknown,
  options: { route: string; allowed: ReadonlySet<VneidErrorCode>; language: Language }
): Response {
  let vneid: VneidError;
  if (isVneidError(error) && options.allowed.has(error.code)) {
    vneid = error;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    vneid = new VneidError('VNEID_INTERNAL', message, {
      detail: isVneidError(error) ? { undocumentedCode: error.code } : undefined,
    });
  }
  const log = { code: vneid.code, message: sanitizeLogText(vneid.message, 300), ...vneid.detail };
  if (LOGGED_AS_ERROR.has(vneid.code)) console.error(`[vneid:${options.route}] failed`, log);
  else if (LOGGED_AS_WARNING.has(vneid.code)) console.warn(`[vneid:${options.route}] refused`, log);

  const headers: Record<string, string> = {};
  if (vneid.retryAfterSeconds !== undefined)
    headers['Retry-After'] = String(vneid.retryAfterSeconds);
  return jsonResponse(
    { error: vneid.code, message: MESSAGES[vneid.code][options.language] },
    vneid.httpStatus,
    headers
  );
}

// ---- request checks (before any body is read) ------------------------------------------

/**
 * The browser's Origin must be this site: APP_ORIGIN when set (production),
 * otherwise the Host the request was sent to (local development). A page on
 * another site cannot make a browser send our origin, so this stops
 * cross-site requests made with the user's browser.
 */
export function checkOrigin(request: Request): void {
  const forbidden = () => new VneidError('VNEID_FORBIDDEN_ORIGIN', 'Origin missing or foreign');
  const origin = request.headers.get('origin');
  if (!origin) throw forbidden();
  const configured = process.env.APP_ORIGIN?.trim().replace(/[/]+$/, '');
  if (configured) {
    if (origin !== configured) throw forbidden();
    return;
  }
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw forbidden();
  }
  if (originHost !== request.headers.get('host')) throw forbidden();
}

export function requireContentType(request: Request, expected: string): void {
  const type = (request.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith(expected)) {
    throw new VneidError('VNEID_UNSUPPORTED_MEDIA_TYPE', `expected ${expected}`);
  }
}

/** The declared body size, required and capped before anything is read. */
export function declaredLength(request: Request, maxBytes: number): number {
  const raw = request.headers.get('content-length');
  if (raw === null || !/^[0-9]+$/.test(raw.trim())) {
    throw new VneidError('VNEID_LENGTH_REQUIRED', 'Content-Length missing');
  }
  const length = Number(raw.trim());
  if (length > maxBytes) {
    throw new VneidError('VNEID_PAYLOAD_TOO_LARGE', 'body too large', {
      detail: { length, maxBytes },
    });
  }
  return length;
}

/** Reads the body, never more than `maxBytes`. */
export async function readBody(request: Request, maxBytes: number): Promise<Buffer> {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new VneidError('VNEID_PAYLOAD_TOO_LARGE', 'body larger than allowed');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** `Authorization: Bearer <client secret>`; an empty string when absent (which
 * then fails authentication like any wrong secret). */
export function bearerSecret(request: Request): string {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '');
  return match?.[1] ?? '';
}

export const toIsoTime = (ms: number) => new Date(ms).toISOString();

/** Requests per second one client (IP, or IPv6 /64) may send to a VNeID route. */
export const PER_IP_PER_SECOND = 3;

/**
 * Requests per second the whole service takes on each route, from every client
 * together. There is no daily quota: these cut a flood -- many addresses at
 * once (DDoS) included -- before it reaches CSign or anyone's phone, and the
 * per-IP window limits of each route stay on top of them.
 */
export const SERVICE_PER_SECOND = {
  /** A push to a phone and a CSign call each. */
  sign: 10,
  registrations: 5,
  /** A CSign call each. */
  credentials: 20,
  'registrations-status': 20,
  providers: 20,
  /** Finalize asks a TSA; status is the page polling every few seconds. */
  finalize: 20,
  status: 100,
  /** Asked once per page load by every visitor. */
  access: 100,
} as const;

export type RateLimitedRoute = keyof typeof SERVICE_PER_SECOND;

/** The 429 to send when `route` is over either per-second limit, else null. */
export function perSecondLimit(route: RateLimitedRoute, clientIp: string): Response | null {
  const perIp = checkRateLimit(`vneid-1s:${route}:${clientIp}`, {
    limit: PER_IP_PER_SECOND,
    windowMs: 1000,
  });
  if (!perIp.allowed) return rateLimitedResponse(perIp.retryAfterSeconds);
  const all = checkRateLimit(`vneid-1s:${route}:*`, {
    limit: SERVICE_PER_SECOND[route],
    windowMs: 1000,
  });
  if (!all.allowed) return rateLimitedResponse(all.retryAfterSeconds);
  return null;
}
