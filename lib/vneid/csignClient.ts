import { z } from 'zod';
import { sanitizeLogText } from '../cas/casPayload';
import { fetchWithTimeout, isTimeoutError } from '../fetchWithTimeout';
import { logCsignExchange } from './csignLog';

/**
 * Client for the CMC CSign Gateway (API spec v1.11), the part KysoQR uses:
 * login / refresh-token, credentials/list, signing/sign-hash,
 * signing/query-status, and for citizens without a certificate provider/list,
 * credentials/register and credentials/get-status.
 *
 * Like lib/cas/CasEsignProvider.ts it gets its base URL and credentials from
 * the caller and never reads process.env. Unlike CAS, CSign hands out
 * short-lived JWTs, so this class keeps one session: it logs in on first use,
 * renews shortly before the token expires (one renewal at a time, however
 * many calls are waiting) and retries a call once when CSign says the token
 * is no longer valid (HTTP 401 or RAR-HUB status `0`).
 *
 * Nothing secret or personal reaches an error message: no token, password or
 * CCCD; CSign's own descriptions go through sanitizeLogText. Callers must not
 * log request or response bodies either.
 */

const CSIGN_TIMEOUT_MS = 15_000;
/** Ceiling for an answer, so a broken or hostile upstream cannot fill memory. */
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** credentials/list carries every certificate of the citizen with its whole
 * chain; on UAT it already exceeds 256 KB. */
const MAX_CREDENTIALS_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Renew this long before the access token's `exp`. */
const TOKEN_SAFETY_MS = 60_000;
/** Used when a token carries no readable `exp`. */
const FALLBACK_TOKEN_LIFETIME_MS = 5 * 60_000;

export type CsignErrorKind =
  /** Login failed or the token was refused even after renewing it. */
  | 'AUTH'
  /** `-01`: the citizen already has a request waiting. */
  | 'PENDING_OTHER'
  /** `04`, `4029`, `4031`: no certificate (or wrong CCCD / credential). */
  | 'NO_CERTIFICATE'
  /** `12`, `4030` not activated; `13` bad state; `21` expired; `4022` broken. */
  | 'CERT_INVALID'
  /** `4025`: requestId already used. */
  | 'DUPLICATE_REQUEST'
  /** Registration: provider or service pack unknown or disabled (`06`, `07`, `22`). */
  | 'PROVIDER_UNAVAILABLE'
  /** Registration: the citizen already has this provider's free certificate (`19`, `30`). */
  | 'ALREADY_REGISTERED'
  /** `08`: CSign does not know this registration transactionCode. */
  | 'NOT_FOUND'
  /** `02`, `03` or HTTP 400: CSign did not accept the request as sent. */
  | 'BAD_REQUEST'
  | 'TIMEOUT'
  /** Anything else: network, 5xx, unreadable or unexpected answer. */
  | 'UPSTREAM';

/**
 * Next.js loads this module more than once (every route bundle, and
 * instrumentation.ts), while the CSign client in the deps shared on globalThis
 * comes from one of the copies. `instanceof` therefore goes by a brand, not by
 * the class object, so an error thrown by any copy is recognized by all.
 */
const CSIGN_ERROR = Symbol.for('kysoqr.vneid.CsignError');

export class CsignError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && CSIGN_ERROR in value;
  }

  readonly kind: CsignErrorKind;
  readonly path: string;
  readonly httpStatus: number | undefined;
  /** RAR-HUB / CSign status code, when the answer carried one. */
  readonly code: string | undefined;

  constructor(
    kind: CsignErrorKind,
    path: string,
    message: string,
    details: { httpStatus?: number; code?: string } = {}
  ) {
    super(`CSign ${path}: ${message}`);
    Object.defineProperty(this, CSIGN_ERROR, { value: true });
    this.name = 'CsignError';
    this.kind = kind;
    this.path = path;
    this.httpStatus = details.httpStatus;
    this.code = details.code;
  }
}

export function isCsignError(value: unknown): value is CsignError {
  return value instanceof CsignError;
}

/** RAR-HUB status codes (spec section V.2) that mean the call did not succeed. */
const FAILURE_CODES: Record<string, CsignErrorKind> = {
  '0': 'AUTH',
  '02': 'BAD_REQUEST',
  '03': 'BAD_REQUEST',
  '04': 'NO_CERTIFICATE',
  '4029': 'NO_CERTIFICATE',
  '4031': 'NO_CERTIFICATE',
  '12': 'CERT_INVALID',
  '13': 'CERT_INVALID',
  '21': 'CERT_INVALID',
  '4022': 'CERT_INVALID',
  '4030': 'CERT_INVALID',
  '4025': 'DUPLICATE_REQUEST',
  '-01': 'PENDING_OTHER',
  '18': 'UPSTREAM',
  '4027': 'UPSTREAM',
  '4028': 'UPSTREAM',
  '4032': 'UPSTREAM',
  '4035': 'UPSTREAM',
  '4036': 'UPSTREAM',
  '4037': 'UPSTREAM',
};

/** RAR-HUB status codes of the registration APIs (spec section V.3). Several
 * share a number with a signing code but mean something else (`04`, `05`...). */
const REGISTRATION_FAILURE_CODES: Record<string, CsignErrorKind> = {
  '0': 'AUTH',
  '02': 'BAD_REQUEST',
  '03': 'BAD_REQUEST',
  '04': 'BAD_REQUEST',
  '05': 'BAD_REQUEST',
  '06': 'PROVIDER_UNAVAILABLE',
  '07': 'PROVIDER_UNAVAILABLE',
  '22': 'PROVIDER_UNAVAILABLE',
  '08': 'NOT_FOUND',
  '19': 'ALREADY_REGISTERED',
  '30': 'ALREADY_REGISTERED',
  '25': 'DUPLICATE_REQUEST',
  '26': 'DUPLICATE_REQUEST',
  '31': 'UPSTREAM',
  '32': 'UPSTREAM',
  '33': 'UPSTREAM',
  '-01': 'PENDING_OTHER',
};

/** Error codes in `result.errorCode` that mean "this token is not accepted". */
const AUTH_ERROR_CODE =
  /UNAUTHORI[SZ]ED|UNAUTHENTICATED|INVALID_TOKEN|TOKEN_EXPIRED|EXPIRED_TOKEN|TOKEN_INVALID/i;

// ---- response shapes (unknown fields are dropped; CSign sends nulls freely) ----------

const text = z.string();
const optionalText = z.string().nullish();
const numberLike = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?[0-9]+$/)
    .transform(Number),
]);

/** Prices may come as decimals, or as decimal strings. */
const amount = z.union([
  z.number().finite(),
  z
    .string()
    .regex(/^-?[0-9]+(\.[0-9]+)?$/)
    .transform(Number),
]);

const loginSchema = z.object({
  success: z.literal(true),
  data: z.object({ token: text.min(1), refreshToken: text.min(1) }),
});

const credentialsSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: optionalText,
    data: z
      .object({
        credentialInfos: z
          .array(
            z.object({
              credentialID: text.min(1),
              cert: z.object({
                status: numberLike.nullish(),
                certificates: z.array(text).min(1),
                issuerDN: optionalText,
                serialNumber: optionalText,
                validTo: optionalText,
              }),
              key: z
                .object({
                  status: optionalText,
                  algo: z.array(text).nullish(),
                  len: numberLike.nullish(),
                })
                .nullish(),
            })
          )
          .nullish(),
      })
      .nullish(),
  }),
});

const signHashSchema = z.object({
  success: z.literal(true),
  data: z.object({ transactionId: text.min(1), rscaTransactionId: optionalText }),
});

const providersSchema = z.object({
  success: z.literal(true),
  data: z
    .object({
      providers: z
        .array(
          z.object({
            providerName: optionalText,
            provider: text.min(1).max(100),
            status: numberLike.nullish(),
            servicePackList: z
              .array(
                z.object({
                  servicePackCode: text.min(1).max(100),
                  servicePackName: optionalText,
                  servicePackMonth: numberLike.nullish(),
                  unitPrice: amount.nullish(),
                  free: numberLike.nullish(),
                })
              )
              .max(100)
              .nullish(),
          })
        )
        .max(100)
        .nullish(),
    })
    .nullish(),
});

const registerSchema = z.object({
  success: z.literal(true),
  data: z.object({ status: optionalText, transactionCode: text.min(1).max(200) }),
});

const registrationStatusSchema = z.object({
  success: z.literal(true),
  data: z.object({
    data: z.object({
      statusCode: numberLike,
      serialNumber: optionalText,
      resultCode: optionalText,
      errorCode: optionalText,
    }),
  }),
});

const signatureEntry = z.union([
  text.transform((signature) => ({ documentId: undefined, signature })),
  z.object({ documentId: optionalText, signature: optionalText }).transform((entry) => ({
    documentId: entry.documentId ?? undefined,
    signature: entry.signature ?? '',
  })),
]);

const queryStatusSchema = z.object({
  success: z.literal(true),
  data: z.object({
    description: optionalText,
    data: z.object({
      statusCode: numberLike,
      resultCode: optionalText,
      errorCode: optionalText,
      signatures: z.array(signatureEntry).nullish(),
    }),
  }),
});

// ---- public types --------------------------------------------------------------------

export interface CsignCredential {
  credentialId: string;
  /** Base64 DER, end-entity first, then intermediate(s), then root. */
  certificates: string[];
  issuerDn: string | undefined;
  serialNumber: string | undefined;
  validTo: string | undefined;
  /** 1 = active (spec section III.9). */
  certStatus: number | undefined;
  keyStatus: string | undefined;
  keyAlgorithms: string[];
  keyLength: number | undefined;
}

export interface SignHashRequest {
  credentialId: string;
  citizenPid: string;
  requestId: string;
  documentId: string;
  documentName: string;
  /** Base64 of the 32-byte digest. */
  digestValue: string;
}

export interface SignHashResult {
  transactionId: string;
  rscaTransactionId: string | undefined;
}

export interface CsignSignature {
  documentId: string | undefined;
  /** Base64, as CSign sent it. */
  signature: string;
}

export interface QueryStatusResult {
  /** 0 failed, 1 created, 2 processing, 3 waiting on VNeID, 4 done, 5 refused. */
  statusCode: number;
  resultCode: string | undefined;
  errorCode: string | undefined;
  signatures: CsignSignature[];
}

export interface CsignServicePack {
  code: string;
  name: string | undefined;
  months: number | undefined;
  unitPrice: number | undefined;
  /** 1 = free, 0 = not (spec section III.5; the spec's own example disagrees). */
  free: number | undefined;
}

export interface CsignProvider {
  provider: string;
  name: string | undefined;
  /** Spec table: 0 active, 1 inactive -- but its example lists CMC with 1. */
  status: number | undefined;
  packs: CsignServicePack[];
}

/** userInfo of credentials/register (spec section III.6); only citizenPid is required. */
export interface RegistrationUserInfo {
  citizenPid: string;
  fullName?: string;
  birthDate?: string;
  gender?: string;
  nationalityCode?: string;
  issuingAuthority?: string;
  dateOfIssue?: string;
  idCardExpireDate?: string;
  phone?: string;
  email?: string;
  permanentAddress?: string;
  permanentVillageText?: string;
  permanentCityText?: string;
  livingPlaceAddress?: string;
  livingPlaceVillageText?: string;
  livingPlaceCityText?: string;
}

export interface RegisterCredentialRequest {
  userInfo: RegistrationUserInfo;
  provider: string;
  servicePackCode: string;
  requestId: string;
}

export interface RegistrationStatusResult {
  /** 0 done, 1 failed, 2 processing, 3 certificate issued but not activated yet. */
  statusCode: number;
  /** Serial of the new certificate (= its credentialID). */
  serialNumber: string | undefined;
  errorCode: string | undefined;
  resultCode: string | undefined;
}

/** What the VNeID service needs from CSign (the class below, or a test double). */
export interface CsignApi {
  listCredentials(citizenPid: string): Promise<CsignCredential[]>;
  signHash(request: SignHashRequest): Promise<SignHashResult>;
  queryStatus(transactionId: string): Promise<QueryStatusResult>;
  listProviders(): Promise<CsignProvider[]>;
  /** Returns the transactionCode to look the registration up with. */
  registerCredential(request: RegisterCredentialRequest): Promise<string>;
  getRegistrationStatus(transactionCode: string): Promise<RegistrationStatusResult>;
}

// ---- helpers -------------------------------------------------------------------------

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

const asCode = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;

/** The status code CSign / RAR-HUB put in an answer: `data.status` (where the
 * spec puts it), `error.code`, or -- only when the answer is not a success --
 * a top-level `code` / `status`. */
function statusCodeOf(body: unknown): string | undefined {
  const root = record(body);
  const data = record(root?.data);
  const error = record(root?.error);
  // Not in the spec, but what the UAT gateway answers on failures:
  // { success: false, result: { errorCode, message } }.
  const result = record(root?.result);
  const topLevel =
    root?.success === true ? undefined : (asCode(root?.code) ?? asCode(root?.status));
  return asCode(data?.status) ?? asCode(error?.code) ?? asCode(result?.errorCode) ?? topLevel;
}

function descriptionOf(body: unknown): string | undefined {
  const root = record(body);
  const data = record(root?.data);
  const error = record(root?.error);
  const result = record(root?.result);
  const found = [
    data?.description,
    data?.message,
    error?.message,
    result?.message,
    root?.message,
  ].find((value): value is string => typeof value === 'string' && value.length > 0);
  return found === undefined ? undefined : sanitizeLogText(found, 200);
}

/** `exp` of a JWT, in ms; undefined when it cannot be read (no signature check:
 * the token is only ever sent back to the server that issued it). */
function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp)
      ? claims.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

async function readLimited(response: Response, path: string, maxBytes: number): Promise<string> {
  const tooLarge = (size: string) =>
    new CsignError('UPSTREAM', path, `answer too large (${size}, limit ${maxBytes} bytes)`, {
      httpStatus: response.status,
    });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge(`${declared} bytes`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(`more than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface Session {
  token: string;
  refreshToken: string;
  /** From then on the access token is renewed before use (exp minus a margin). */
  renewAt: number;
}

export class CsignClient implements CsignApi {
  private session: Session | undefined;
  private renewing: Promise<string> | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
    private readonly now: () => number = Date.now
  ) {}

  private buildUrl(path: string): string {
    return new URL(path.replace(/^[/]/, ''), this.baseUrl.replace(/[/]?$/, '/')).toString();
  }

  /** One HTTP exchange: a JSON POST, or a GET when there is no body
   * (provider/list). Returns the parsed JSON of a successful answer. */
  private async exchange(
    path: string,
    body: object | undefined,
    token: string | undefined,
    maxBytes = MAX_RESPONSE_BYTES,
    failureCodes: Record<string, CsignErrorKind> = FAILURE_CODES
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;

    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;
    let response: Response;
    try {
      response = await fetchWithTimeout(
        this.buildUrl(path),
        {
          method: body === undefined ? 'GET' : 'POST',
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          cache: 'no-store',
        },
        CSIGN_TIMEOUT_MS
      );
    } catch (error) {
      const timedOut = isTimeoutError(error);
      logCsignExchange({
        path,
        httpStatus: undefined,
        ms: elapsed(),
        request: body,
        failure: timedOut ? 'timeout' : 'network error or redirect',
      });
      if (timedOut) throw new CsignError('TIMEOUT', path, 'no answer in time');
      throw new CsignError('UPSTREAM', path, 'request failed (network or redirect)');
    }

    let raw: string;
    try {
      raw = await readLimited(response, path, maxBytes);
    } catch (error) {
      logCsignExchange({
        path,
        httpStatus: response.status,
        ms: elapsed(),
        request: body,
        failure: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }

    const code = statusCodeOf(parsed);
    logCsignExchange({
      path,
      httpStatus: response.status,
      ms: elapsed(),
      bytes: Buffer.byteLength(raw),
      code,
      request: body,
      // Not JSON (an HTML error page...): its beginning, redacted like the rest.
      response: parsed ?? (raw.length > 0 ? raw.slice(0, 300) : undefined),
    });
    const codeKind = code === undefined ? undefined : failureCodes[code];
    const details = { httpStatus: response.status, ...(code === undefined ? {} : { code }) };
    const describe = (what: string) =>
      [
        what,
        `HTTP ${response.status}`,
        code === undefined ? '' : `code ${code}`,
        descriptionOf(parsed),
      ]
        .filter(Boolean)
        .join(', ');

    if (response.status === 401 || (code !== undefined && AUTH_ERROR_CODE.test(code))) {
      throw new CsignError('AUTH', path, describe('unauthorized'), details);
    }
    if (codeKind) throw new CsignError(codeKind, path, describe('refused'), details);
    if (!response.ok) {
      const kind: CsignErrorKind = response.status === 400 ? 'BAD_REQUEST' : 'UPSTREAM';
      throw new CsignError(kind, path, describe('failed'), details);
    }
    if (parsed === undefined) {
      throw new CsignError('UPSTREAM', path, describe('answer is not JSON'), details);
    }
    if (record(parsed)?.success === false) {
      throw new CsignError('UPSTREAM', path, describe('success=false'), details);
    }
    return parsed;
  }

  private parse<T>(schema: z.ZodType<T>, path: string, body: unknown): T {
    const result = schema.safeParse(body);
    if (!result.success) {
      // Field paths only: the values may be personal.
      const fields = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
      throw new CsignError('UPSTREAM', path, `unexpected answer shape at ${fields.join(', ')}`);
    }
    return result.data;
  }

  private startSession(body: unknown, path: string, how: 'login' | 'refresh'): string {
    const { data } = this.parse(loginSchema, path, body);
    const tokenExpiry = jwtExpiryMs(data.token);
    const refreshExpiry = jwtExpiryMs(data.refreshToken);
    const expiry = tokenExpiry ?? this.now() + FALLBACK_TOKEN_LIFETIME_MS;
    this.session = {
      token: data.token,
      refreshToken: data.refreshToken,
      renewAt: expiry - TOKEN_SAFETY_MS,
    };
    // Lifetimes only -- never a token.
    const minutesLeft = (at: number | undefined) =>
      at === undefined ? undefined : Math.round((at - this.now()) / 60_000);
    console.info(`[vneid:csign] ${how === 'login' ? 'logged in' : 'token refreshed'}`, {
      tokenMinutes: minutesLeft(tokenExpiry),
      refreshTokenMinutes: minutesLeft(refreshExpiry),
    });
    return data.token;
  }

  private async renew(): Promise<string> {
    const previous = this.session;
    this.session = undefined;
    const refreshExpiry = previous ? jwtExpiryMs(previous.refreshToken) : undefined;
    if (previous && (refreshExpiry === undefined || refreshExpiry > this.now())) {
      const path = '/api/auth/refresh-token';
      try {
        // The answer is a new pair: the old refresh token is spent.
        const body = await this.exchange(path, { refreshToken: previous.refreshToken }, undefined);
        return this.startSession(body, path, 'refresh');
      } catch (error) {
        console.warn('[vneid:csign] token refresh failed, logging in again', {
          reason:
            error instanceof CsignError ? `${error.kind} ${error.code ?? ''}`.trim() : 'error',
        });
      }
    } else if (previous) {
      console.info('[vneid:csign] refresh token expired, logging in again');
    }
    const path = '/api/auth/login';
    const body = await this.exchange(
      path,
      { username: this.username, password: this.password },
      undefined
    );
    return this.startSession(body, path, 'login');
  }

  private accessToken(): Promise<string> {
    if (this.session && this.session.renewAt > this.now()) {
      return Promise.resolve(this.session.token);
    }
    this.renewing ??= this.renew().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  /** Authenticated call; on an auth refusal the token is renewed and the call retried once. */
  private async call(
    path: string,
    body: object | undefined,
    maxBytes?: number,
    failureCodes?: Record<string, CsignErrorKind>
  ): Promise<unknown> {
    const token = await this.accessToken();
    try {
      return await this.exchange(path, body, token, maxBytes, failureCodes);
    } catch (error) {
      if (!(error instanceof CsignError) || error.kind !== 'AUTH') throw error;
      console.warn('[vneid:csign] CSign refused the token, renewing it once', { path });
      // Expire only the token that was refused; a concurrent renewal may
      // already have replaced it.
      if (this.session?.token === token) this.session = { ...this.session, renewAt: 0 };
      return this.exchange(path, body, await this.accessToken(), maxBytes, failureCodes);
    }
  }

  async listCredentials(citizenPid: string): Promise<CsignCredential[]> {
    const path = '/api/credentials/list';
    const answer = await this.call(path, { citizenPid }, MAX_CREDENTIALS_RESPONSE_BYTES);
    const body = this.parse(credentialsSchema, path, answer);
    return (body.data.data?.credentialInfos ?? []).map((info) => ({
      credentialId: info.credentialID,
      certificates: info.cert.certificates,
      issuerDn: info.cert.issuerDN ?? undefined,
      serialNumber: info.cert.serialNumber ?? undefined,
      validTo: info.cert.validTo ?? undefined,
      certStatus: info.cert.status ?? undefined,
      keyStatus: info.key?.status ?? undefined,
      keyAlgorithms: info.key?.algo ?? [],
      keyLength: info.key?.len ?? undefined,
    }));
  }

  async signHash(request: SignHashRequest): Promise<SignHashResult> {
    const path = '/api/signing/sign-hash';
    const answer = await this.call(path, {
      credentialID: request.credentialId,
      signerCCCD: request.citizenPid,
      requestId: request.requestId,
      documents: [
        {
          documentId: request.documentId,
          documentName: request.documentName,
          digestValue: request.digestValue,
        },
      ],
      serviceType: 'vneid',
    });
    const body = this.parse(signHashSchema, path, answer);
    return {
      transactionId: body.data.transactionId,
      rscaTransactionId: body.data.rscaTransactionId ?? undefined,
    };
  }

  async queryStatus(transactionId: string): Promise<QueryStatusResult> {
    const path = '/api/signing/query-status';
    const body = this.parse(queryStatusSchema, path, await this.call(path, { transactionId }));
    const result = body.data.data;
    return {
      statusCode: result.statusCode,
      resultCode: result.resultCode ?? undefined,
      errorCode: result.errorCode ?? undefined,
      signatures: result.signatures?.filter((entry) => entry.signature.length > 0) ?? [],
    };
  }

  async listProviders(): Promise<CsignProvider[]> {
    const path = '/api/provider/list';
    const body = this.parse(providersSchema, path, await this.call(path, undefined));
    return (body.data?.providers ?? []).map((provider) => ({
      provider: provider.provider,
      name: provider.providerName ?? undefined,
      status: provider.status ?? undefined,
      packs: (provider.servicePackList ?? []).map((pack) => ({
        code: pack.servicePackCode,
        name: pack.servicePackName ?? undefined,
        months: pack.servicePackMonth ?? undefined,
        unitPrice: pack.unitPrice ?? undefined,
        free: pack.free ?? undefined,
      })),
    }));
  }

  async registerCredential(request: RegisterCredentialRequest): Promise<string> {
    const path = '/api/credentials/register';
    const answer = await this.call(
      path,
      {
        userInfo: request.userInfo,
        provider: request.provider,
        servicePackCode: request.servicePackCode,
        requestId: request.requestId,
      },
      undefined,
      REGISTRATION_FAILURE_CODES
    );
    return this.parse(registerSchema, path, answer).data.transactionCode;
  }

  async getRegistrationStatus(transactionCode: string): Promise<RegistrationStatusResult> {
    const path = '/api/credentials/get-status';
    const answer = await this.call(
      path,
      { transactionCode },
      undefined,
      REGISTRATION_FAILURE_CODES
    );
    const result = this.parse(registrationStatusSchema, path, answer).data.data;
    return {
      statusCode: result.statusCode,
      serialNumber: result.serialNumber ?? undefined,
      errorCode: result.errorCode ?? undefined,
      resultCode: result.resultCode ?? undefined,
    };
  }
}
