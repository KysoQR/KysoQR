import type { SignatureFieldProps } from '@/lib/domain/SignatureField';
import { parseJsonSafely } from '@/lib/http';

/**
 * Browser side of the VNeID API (app/api/vneid/*). Browser-only: nothing
 * here imports server code. The routes answer `{ error, message }` on
 * failure with `message` already written for the user (vi/en, from the
 * Accept-Language sent here), so errors keep that message as is.
 */

export type VneidLanguage = 'vi' | 'en';

/** Mirrors lib/vneid/service.ts CredentialView (never the holder's name). */
export interface VneidCredential {
  credentialId: string;
  issuer: string | null | undefined;
  validFrom: string | null | undefined;
  validTo: string | null | undefined;
  keyBits: number | null | undefined;
  usable: boolean;
  reason?:
    | 'NOT_ACTIVE'
    | 'EXPIRED'
    | 'NOT_YET_VALID'
    | 'UID_MISMATCH'
    | 'KEY_UNSUPPORTED'
    | 'KEY_USAGE'
    | 'SERIAL_MISMATCH'
    | 'CHAIN_BROKEN'
    | 'MALFORMED';
  rootTrusted: boolean;
  /** The CA certificates CSign sent really issued this certificate. */
  chainVerified: boolean;
  chainIssue?:
    'issuer-not-ca' | 'name-mismatch' | 'signature-mismatch' | 'ca-expired' | 'ca-not-yet-valid';
}

/** Mirrors lib/vneid/registration.ts ProviderView. */
export interface VneidServicePack {
  code: string;
  name: string;
  months: number | null;
  /** VND; null when CSign does not say. */
  unitPrice: number | null;
  free: boolean;
}

export interface VneidProvider {
  provider: string;
  name: string;
  packs: VneidServicePack[];
}

export type VneidRegistrationStatus =
  'PENDING' | 'ISSUED' | 'COMPLETED' | 'FAILED' | 'REJECTED' | 'EXPIRED';

/** Mirrors lib/vneid/registration.ts RegistrationView (never the form). */
export interface VneidRegistration {
  status: VneidRegistrationStatus;
  reason?: 'REFUSED' | 'TIMEOUT' | 'CITIZEN_INFO' | 'PROVIDER';
  provider: string;
  providerName: string;
  servicePackCode: string;
  servicePackName: string;
  months: number | null;
  unitPrice: number | null;
  createdAt: string;
  expiresAt: string;
  /** The new certificate's credentialId (COMPLETED only). */
  serialNumber?: string;
}

export interface VneidTicket {
  transactionId: string;
  /** Bearer secret: kept in memory only, never in a URL or storage. */
  clientSecret: string;
  confirmDeadline: string;
  expiresAt: string;
  codeRequired: boolean;
  documentName: string;
}

export type VneidStatus =
  'PENDING' | 'WAITING_USER' | 'SIGNED' | 'FINALIZED' | 'REJECTED' | 'EXPIRED' | 'FAILED';

export interface VneidStatusView {
  status: VneidStatus;
  reason?: 'REFUSED' | 'TIMEOUT' | 'SIGNATURE_UNUSABLE' | 'CODE_ATTEMPTS' | 'PROVIDER';
  confirmDeadline: string;
  expiresAt: string;
  codeRequired: boolean;
}

export class VneidApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, code: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = 'VneidApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function retryAfterOf(res: Response): number | undefined {
  const value = Number(res.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function failure(res: Response): Promise<VneidApiError> {
  const data = (await parseJsonSafely(res).catch((error: unknown) => ({
    message: error instanceof Error ? error.message : String(error),
  }))) as { error?: string; message?: string };
  return new VneidApiError(
    data.message ?? `HTTP ${res.status}`,
    data.error ?? 'HTTP_ERROR',
    res.status,
    retryAfterOf(res)
  );
}

const languageHeader = (language: VneidLanguage) => ({ 'Accept-Language': language });

export async function fetchVneidCredentials(
  citizenPid: string,
  language: VneidLanguage
): Promise<VneidCredential[]> {
  const res = await fetch('/api/vneid/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...languageHeader(language) },
    body: JSON.stringify({ citizenPid }),
  });
  if (!res.ok) throw await failure(res);
  return ((await parseJsonSafely(res)) as { credentials: VneidCredential[] }).credentials;
}

export async function fetchVneidProviders(language: VneidLanguage): Promise<VneidProvider[]> {
  const res = await fetch('/api/vneid/providers', { headers: languageHeader(language) });
  if (!res.ok) throw await failure(res);
  return ((await parseJsonSafely(res)) as { providers: VneidProvider[] }).providers;
}

/** Sends the registration form; it goes to CSign and is not kept anywhere. */
export async function startVneidRegistration(input: {
  citizenPid: string;
  provider: string;
  servicePackCode: string;
  /** Picks among packs CSign lists under the same code. */
  servicePackName?: string;
  userInfo: Record<string, string>;
  language: VneidLanguage;
}): Promise<VneidRegistration> {
  const res = await fetch('/api/vneid/registrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...languageHeader(input.language) },
    body: JSON.stringify({
      citizenPid: input.citizenPid,
      provider: input.provider,
      servicePackCode: input.servicePackCode,
      servicePackName: input.servicePackName,
      userInfo: input.userInfo,
    }),
  });
  if (!res.ok) throw await failure(res);
  return ((await parseJsonSafely(res)) as { registration: VneidRegistration }).registration;
}

/** The CCCD's open (or just finished) registration, or null. */
export async function fetchVneidRegistration(
  citizenPid: string,
  language: VneidLanguage
): Promise<VneidRegistration | null> {
  const res = await fetch('/api/vneid/registrations/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...languageHeader(language) },
    body: JSON.stringify({ citizenPid }),
  });
  if (!res.ok) throw await failure(res);
  return ((await parseJsonSafely(res)) as { registration: VneidRegistration | null }).registration;
}

export async function startVneidSigning(input: {
  file: File;
  fields: SignatureFieldProps[];
  citizenPid: string;
  credentialId: string;
  language: VneidLanguage;
}): Promise<VneidTicket> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('citizenPid', input.citizenPid);
  form.append('signatureFields', JSON.stringify(input.fields));
  form.append('language', input.language);
  form.append('credentialId', input.credentialId);
  const res = await fetch('/api/vneid/sign', {
    method: 'POST',
    headers: languageHeader(input.language),
    body: form,
  });
  if (!res.ok) throw await failure(res);
  return (await parseJsonSafely(res)) as VneidTicket;
}

export async function fetchVneidStatus(
  ticket: VneidTicket,
  language: VneidLanguage
): Promise<VneidStatusView> {
  const res = await fetch('/api/vneid/status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ticket.clientSecret}`,
      ...languageHeader(language),
    },
    body: JSON.stringify({ transactionId: ticket.transactionId }),
  });
  if (!res.ok) throw await failure(res);
  return (await parseJsonSafely(res)) as VneidStatusView;
}

/** Sends the ORIGINAL file back; answers with the signed PDF. */
export async function finalizeVneidSigning(
  ticket: VneidTicket,
  original: File,
  language: VneidLanguage,
  code?: string
): Promise<Blob> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'x-vneid-tx': ticket.transactionId,
    Authorization: `Bearer ${ticket.clientSecret}`,
    ...languageHeader(language),
  };
  if (code) headers['x-vneid-code'] = code.trim().toUpperCase();
  const res = await fetch('/api/vneid/finalize', { method: 'POST', headers, body: original });
  if (!res.ok) throw await failure(res);
  return res.blob();
}
