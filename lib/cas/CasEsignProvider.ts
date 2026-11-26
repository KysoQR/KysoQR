import { readPdfFromResponseBody, sanitizeLogText } from './casPayload';
import { fetchWithTimeout } from '../fetchWithTimeout';
import type {
  CasProvider,
  DownloadFileResult,
  RequestStatusResult,
  SigningRoundDetail,
  SigningRoundResult,
  SubmitDocumentInput,
  SubmitDocumentResult,
} from './CasProvider';

/** Small JSON calls (status check, signing-round lookup) -- should be fast;
 * no reason to wait as long as an upload/download for these to fail. */
const CAS_JSON_TIMEOUT_MS = 10_000;
/** File-carrying calls (submitting a PDF, downloading the signed one back) --
 * given more room since transferring the actual bytes takes longer, especially
 * over a slow connection. */
const CAS_FILE_TIMEOUT_MS = 30_000;

const CAS_ERR_PERSON_NOT_FOUND = 'E_SIGN_PERSON_NOT_FOUND';
const CAS_ERR_SIGNING_ROUND_NOT_FOUND = 'E_SIGN_SIGNING_ROUND_NOT_FOUND';
const CAS_ERR_CERTIFICATE_NOT_FOUND = 'E_SIGN_CERTIFICATE_NOT_FOUND';

export class CasESignError extends Error {
  readonly status?: number;
  readonly errorCode?: string;
  readonly errorType?: string;
  readonly casRequestId?: string;

  constructor(
    message: string,
    details: { status?: number; errorCode?: string; errorType?: string; casRequestId?: string } = {}
  ) {
    super(message);
    this.name = 'CasESignError';
    this.status = details.status;
    this.errorCode = details.errorCode;
    this.errorType = details.errorType;
    this.casRequestId = details.casRequestId;
  }
}

interface CasErrorBody {
  requestId?: string;
  errorCode?: string;
  errorMessage?: string;
  errorType?: string;
}

interface CasRequestDocumentResponse {
  requestId: string;
  pushSignRequestDocument?: SubmitDocumentResult;
  signRequestDocument?: SubmitDocumentResult;
}

interface CasRequestStatusResponse {
  requestId: string;
  signRequestStatus: RequestStatusResult;
}

interface CasSigningRoundResponse {
  requestId: string;
  signingRound?: SigningRoundDetail;
}

/**
 * Real CAS adapter — the only CasProvider implementation. Ported from
 * x-sign-api/src/infrastructure/external-clients/cas-esign/index.ts —
 * same auth headers, same 2-endpoint quirks (submit response entity renamed,
 * download-file's dual response shape), no behavior invented here.
 *
 * `baseUrl`/`clientId`/`apiKey` are injected by the caller (see
 * lib/cas/getCasProvider.ts, which reads them from lib/env.ts) — this class
 * never reads process.env or hardcodes any endpoint/credential itself.
 */
export class CasEsignProvider implements CasProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly apiKey: string
  ) {}

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Accept: 'application/json',
      'x-client-id': this.clientId,
      'x-secret-key': this.apiKey,
      ...extra,
    };
  }

  private buildUrl(path: string): string {
    return new URL(path.replace(/^\//, ''), this.baseUrl.replace(/\/?$/, '/')).toString();
  }

  private async parseResponse(response: Response): Promise<unknown> {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.toLowerCase().includes('application/json')) return response.json();
    const text = await response.text();
    return text.length > 0 ? text : undefined;
  }

  private toError(path: string, response: Response, body: unknown): CasESignError {
    const err = (body ?? {}) as CasErrorBody;
    const message = err.errorMessage ?? (typeof body === 'string' ? body : JSON.stringify(body));
    return new CasESignError(
      `CasESign ${path} failed: ${response.status} ${err.errorCode ?? ''} ${message}`.trim(),
      {
        status: response.status,
        errorCode: err.errorCode,
        errorType: err.errorType,
        casRequestId: err.requestId,
      }
    );
  }

  private async postJson<TRes>(
    path: string,
    data: object,
    timeoutMs: number = CAS_JSON_TIMEOUT_MS
  ): Promise<TRes> {
    const url = this.buildUrl(path);
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(data),
      },
      timeoutMs
    );
    const parsed = await this.parseResponse(response);
    if (!response.ok) throw this.toError(path, response, parsed);
    return parsed as TRes;
  }

  private async getJson<TRes>(
    path: string,
    timeoutMs: number = CAS_JSON_TIMEOUT_MS
  ): Promise<TRes> {
    const url = this.buildUrl(path);
    const response = await fetchWithTimeout(
      url,
      { method: 'GET', headers: this.buildHeaders() },
      timeoutMs
    );
    const parsed = await this.parseResponse(response);
    if (!response.ok) throw this.toError(path, response, parsed);
    return parsed as TRes;
  }

  async submitDocument(input: SubmitDocumentInput): Promise<SubmitDocumentResult> {
    const path = '/esign/request-document';
    const form = new FormData();
    form.append('signRequestId', input.signRequestId);
    form.append('documentName', input.documentName);
    form.append('signatureFields', JSON.stringify(input.signatureFields));
    if (input.organizationName) form.append('organizationName', input.organizationName);
    if (input.signType) form.append('signType', input.signType);
    if (input.taxCode) form.append('taxCode', input.taxCode);
    if (input.language) form.append('language', input.language);
    if (input.identificationNumber) form.append('identificationNumber', input.identificationNumber);
    form.append(
      'file',
      new Blob([input.file.buffer as unknown as BlobPart], {
        type: input.file.contentType ?? 'application/pdf',
      }),
      input.file.filename
    );

    const response = await fetchWithTimeout(
      this.buildUrl(path),
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: form,
      },
      CAS_FILE_TIMEOUT_MS
    );
    const parsed = (await this.parseResponse(response)) as CasRequestDocumentResponse;
    if (!response.ok) throw this.toError(path, response, parsed);

    // CAS renamed `signRequestDocument` to `pushSignRequestDocument` when it
    // merged the two submit endpoints — read both defensively.
    const result = parsed.pushSignRequestDocument ?? parsed.signRequestDocument;
    if (!result) throw new Error('CAS submit succeeded but carried no sign-request entity');
    return result;
  }

  async requestStatus(signRequestId: string): Promise<RequestStatusResult> {
    const response = await this.postJson<CasRequestStatusResponse>('/esign/request-status', {
      signRequestId,
    });
    return response.signRequestStatus;
  }

  async downloadFile(identityKey: string): Promise<DownloadFileResult> {
    const path = '/esign/download-file';
    const response = await fetchWithTimeout(
      this.buildUrl(path),
      {
        method: 'POST',
        headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ identityKey }),
      },
      CAS_FILE_TIMEOUT_MS
    );
    const raw = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type');

    if (!response.ok) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
      } catch {
        parsed = Buffer.from(raw).toString('utf8');
      }
      throw this.toError(path, response, parsed);
    }

    const bytes = readPdfFromResponseBody(raw, contentType);
    return { bytes, contentType: 'application/pdf' };
  }

  async getSigningRound(orgIdSigned: string): Promise<SigningRoundResult> {
    const response = await this.getJson<CasSigningRoundResponse>(
      `/esign/signing-round/${encodeURIComponent(orgIdSigned)}`
    );
    return { signingRound: response.signingRound ?? null };
  }

  isPersonNotFoundError(error: unknown): boolean {
    return error instanceof CasESignError && error.errorCode === CAS_ERR_PERSON_NOT_FOUND;
  }

  isRateLimitedError(error: unknown): boolean {
    return error instanceof CasESignError && error.status === 429;
  }

  isSigningRoundNotFoundError(error: unknown): boolean {
    return error instanceof CasESignError && error.errorCode === CAS_ERR_SIGNING_ROUND_NOT_FOUND;
  }

  isCertificateNotFoundError(error: unknown): boolean {
    return error instanceof CasESignError && error.errorCode === CAS_ERR_CERTIFICATE_NOT_FOUND;
  }
}

// Re-exported so route handlers/logging can redact request bodies consistently.
export { sanitizeLogText };
