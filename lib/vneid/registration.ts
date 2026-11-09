import { randomUUID } from 'node:crypto';
import { sanitizeDisplayText } from '../pdfSign/text';
import { citizenKey } from './crypto';
import { CsignError, type RegistrationStatusResult } from './csignClient';
import { VneidError, type VneidErrorCode } from './errors';
import { checkRegistrationForm } from './registrationForm';
import type { VneidDeps } from './service';
import type { RegistrationRow, RegistrationStatus } from './store';

/**
 * Registering a new certificate for a citizen who has none (CSign
 * provider/list -> credentials/register -> credentials/get-status).
 *
 * CSign then asks the citizen, on VNeID, to share their details; the CA
 * issues the certificate and the citizen activates it in the app. That takes
 * minutes, so the registration is kept in SQLite under the citizen's key
 * (an HMAC of the CCCD, never the number) until it ends: reloading the page and
 * typing the same CCCD finds it again. Only what the page shows is kept --
 * provider, pack, status, CSign's codes -- never the form.
 *
 * Status comes from get-status, asked when the page asks and at most every few
 * seconds (no webhook needed). Anyone who types a CCCD sees the same as for
 * /credentials: a status, never a name.
 */

/** An open registration that never ends at CSign is dropped after a day. */
export const REGISTRATION_TTL_MS = 24 * 60 * 60_000;
/** A finished one stays visible this long. */
const KEEP_FINISHED_MS = 24 * 60 * 60_000;
const SUBMITTING_TTL_MS = 2 * 60_000;
const PROVIDERS_CACHE_MS = 10 * 60_000;
/** get-status at most every 5 s while the citizen is likely on the phone, then every minute. */
const FAST_CHECK_MS = 5_000;
const SLOW_CHECK_MS = 60_000;
const FAST_WINDOW_MS = 30 * 60_000;
/** CSign may not know a fresh transactionCode yet. */
const NOT_FOUND_GRACE_MS = 2 * 60_000;

export interface ServicePackView {
  code: string;
  name: string;
  months: number | null;
  /** In VND; null when CSign does not say. */
  unitPrice: number | null;
  free: boolean;
}

export interface ProviderView {
  provider: string;
  name: string;
  packs: ServicePackView[];
}

export type RegistrationReason = 'REFUSED' | 'TIMEOUT' | 'CITIZEN_INFO' | 'PROVIDER';

export interface RegistrationView {
  /** SUBMITTING is reported as PENDING. */
  status: Exclude<RegistrationStatus, 'SUBMITTING'>;
  reason?: RegistrationReason;
  provider: string;
  providerName: string;
  servicePackCode: string;
  servicePackName: string;
  months: number | null;
  unitPrice: number | null;
  createdAt: string;
  expiresAt: string;
  /** The new certificate's serial, which is its credentialId (COMPLETED only). */
  serialNumber?: string;
}

const cache = new WeakMap<VneidDeps, { at: number; providers: ProviderView[] }>();
const cleanName = (value: string | undefined, fallback: string) =>
  sanitizeDisplayText(value ?? '', 200) || fallback;

function failure(error: unknown, what: string): VneidError {
  if (error instanceof VneidError) return error;
  if (!(error instanceof CsignError)) {
    return new VneidError(
      'VNEID_INTERNAL',
      `${what}: ${error instanceof Error ? error.message : 'error'}`
    );
  }
  const codes: Partial<Record<CsignError['kind'], VneidErrorCode>> = {
    PENDING_OTHER: 'VNEID_REGISTRATION_PENDING',
    ALREADY_REGISTERED: 'VNEID_ALREADY_REGISTERED',
    PROVIDER_UNAVAILABLE: 'VNEID_PROVIDER_UNAVAILABLE',
    BAD_REQUEST: 'VNEID_REGISTRATION_INVALID',
  };
  return new VneidError(codes[error.kind] ?? 'VNEID_UPSTREAM', error.message, {
    detail: { csignKind: error.kind, csignCode: error.code, path: error.path },
  });
}

/** The providers and their packs (all of them, paid ones included), cached. */
export async function listProviders(deps: VneidDeps, fresh = false): Promise<ProviderView[]> {
  const now = deps.now();
  const cached = cache.get(deps);
  if (!fresh && cached && now - cached.at < PROVIDERS_CACHE_MS) return cached.providers;
  let raw;
  try {
    raw = await deps.csign.listProviders();
  } catch (error) {
    throw failure(error, 'provider list');
  }
  const providers = raw.map((provider) => ({
    provider: provider.provider,
    name: cleanName(provider.name, provider.provider),
    packs: provider.packs.map((pack) => ({
      code: pack.code,
      name: cleanName(pack.name, pack.code),
      months: pack.months ?? null,
      unitPrice: pack.unitPrice ?? null,
      free: pack.free === 1 || pack.unitPrice === 0,
    })),
  }));
  cache.set(deps, { at: now, providers });
  return providers;
}

const REFUSED = new Set(['errorcode06', 'errorcode4004']);
const TIMED_OUT = new Set(['errorcode07', 'errorcode4005', 'errorcode4006', 'LOCAL_TIMEOUT']);
const CITIZEN_INFO = new Set(['errorcode02', 'errorcode08', 'errorcode4008']);

function reasonOf(row: RegistrationRow): RegistrationReason | undefined {
  if (row.status === 'REJECTED') return 'REFUSED';
  if (row.status === 'EXPIRED') return 'TIMEOUT';
  if (row.status !== 'FAILED') return undefined;
  const code = row.errorCode ?? '';
  if (REFUSED.has(code)) return 'REFUSED';
  if (TIMED_OUT.has(code)) return 'TIMEOUT';
  return CITIZEN_INFO.has(code) ? 'CITIZEN_INFO' : 'PROVIDER';
}

function viewOf(row: RegistrationRow): RegistrationView {
  const reason = reasonOf(row);
  return {
    status: row.status === 'SUBMITTING' ? 'PENDING' : row.status,
    ...(reason ? { reason } : {}),
    provider: row.provider,
    providerName: row.providerName,
    servicePackCode: row.servicePackCode,
    servicePackName: row.servicePackName,
    months: row.servicePackMonths,
    unitPrice: row.unitPrice,
    createdAt: new Date(row.createdAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    ...(row.status === 'COMPLETED' && row.serialNumber ? { serialNumber: row.serialNumber } : {}),
  };
}

export interface RegistrationInput {
  citizenPid: string;
  provider: unknown;
  servicePackCode: unknown;
  /** Which of the packs listed under one code (CSign repeats some codes); a
   * name CSign does not list for that code is ignored. Display only: CSign
   * itself gets the code. */
  servicePackName?: unknown;
  userInfo: unknown;
}

/** Sends the registration to CSign; the citizen continues on VNeID. */
export async function startRegistration(
  deps: VneidDeps,
  input: RegistrationInput
): Promise<RegistrationView> {
  const form = checkRegistrationForm(input.userInfo, deps.now());
  if (!form.ok) {
    throw new VneidError('VNEID_REGISTRATION_INVALID', 'registration form refused', {
      detail: { fields: Object.keys(form.problems).join(',') },
    });
  }
  if (typeof input.provider !== 'string' || typeof input.servicePackCode !== 'string') {
    throw new VneidError('VNEID_REGISTRATION_INVALID', 'provider or pack missing');
  }
  const find = (providers: ProviderView[]) => {
    const provider = providers.find((item) => item.provider === input.provider);
    const packs = provider?.packs.filter((item) => item.code === input.servicePackCode) ?? [];
    const pack = packs.find((item) => item.name === input.servicePackName) ?? packs[0];
    return provider && pack ? { provider, pack } : undefined;
  };
  // Only a provider and pack CSign lists right now; a stale cache gets one refresh.
  const chosen = find(await listProviders(deps)) ?? find(await listProviders(deps, true));
  if (!chosen) throw new VneidError('VNEID_PROVIDER_UNAVAILABLE', 'provider or pack not listed');

  const key = citizenKey(deps.keys, input.citizenPid);
  const now = deps.now();

  const id = randomUUID();
  const requestId = randomUUID();
  const reserved = deps.store.reserveRegistration(
    {
      id,
      requestId,
      citizenKey: key,
      provider: chosen.provider.provider,
      providerName: chosen.provider.name,
      servicePackCode: chosen.pack.code,
      servicePackName: chosen.pack.name,
      servicePackMonths: chosen.pack.months,
      unitPrice: chosen.pack.unitPrice,
      createdAt: now,
      expiresAt: now + REGISTRATION_TTL_MS,
    },
    SUBMITTING_TTL_MS
  );
  if (reserved === 'citizen-busy') {
    throw new VneidError('VNEID_REGISTRATION_PENDING', 'a registration is already open');
  }

  let transactionCode: string;
  try {
    transactionCode = await deps.csign.registerCredential({
      userInfo: { ...form.userInfo, citizenPid: input.citizenPid },
      provider: chosen.provider.provider,
      servicePackCode: chosen.pack.code,
      requestId,
    });
  } catch (error) {
    const kind = error instanceof CsignError ? error.kind : 'ERROR';
    deps.store.finishRegistration(id, 'FAILED', { errorCode: `CSIGN_${kind}` }, deps.now());
    throw failure(error, 'register');
  }
  deps.store.markRegistrationSubmitted(id, transactionCode, deps.now());
  console.info('[vneid:register] registration sent', {
    registrationId: id,
    provider: chosen.provider.provider,
    pack: chosen.pack.code,
  });
  return viewOf(deps.store.getRegistration(id)!);
}

/** What get-status says, applied to the stored registration. */
function applyStatus(deps: VneidDeps, row: RegistrationRow, result: RegistrationStatusResult) {
  const now = deps.now();
  const { statusCode, errorCode } = result;
  if (statusCode === 2 || statusCode === 3) {
    deps.store.markRegistrationProgress(
      row.id,
      statusCode === 3 ? 'ISSUED' : 'PENDING',
      statusCode,
      now
    );
    return;
  }
  if (statusCode !== 0 && statusCode !== 1) return;
  const status =
    statusCode === 0
      ? 'COMPLETED'
      : REFUSED.has(errorCode ?? '')
        ? 'REJECTED'
        : TIMED_OUT.has(errorCode ?? '')
          ? 'EXPIRED'
          : 'FAILED';
  const details = {
    csignStatus: statusCode,
    ...(errorCode ? { errorCode } : {}),
    ...(result.serialNumber ? { serialNumber: result.serialNumber } : {}),
  };
  if (deps.store.finishRegistration(row.id, status, details, now)) {
    console.info('[vneid:register] registration ended', {
      registrationId: row.id,
      status,
      errorCode,
    });
  }
}

/** The citizen's current (or just finished) registration, refreshed from CSign. */
export async function getRegistration(
  deps: VneidDeps,
  citizenPid: string
): Promise<RegistrationView | null> {
  const key = citizenKey(deps.keys, citizenPid);
  const now = deps.now();
  const row = deps.store.latestRegistration(key, now, KEEP_FINISHED_MS, SUBMITTING_TTL_MS);
  if (!row) return null;
  const interval = now - row.createdAt < FAST_WINDOW_MS ? FAST_CHECK_MS : SLOW_CHECK_MS;
  if (row.transactionCode && deps.store.claimRegistrationCheck(row.id, now, interval)) {
    try {
      applyStatus(deps, row, await deps.csign.getRegistrationStatus(row.transactionCode));
    } catch (error) {
      if (
        error instanceof CsignError &&
        error.kind === 'NOT_FOUND' &&
        now - row.createdAt > NOT_FOUND_GRACE_MS
      ) {
        deps.store.finishRegistration(row.id, 'FAILED', { errorCode: 'CSIGN_NOT_FOUND' }, now);
      } else {
        // The page asks again in a few seconds; nothing to change meanwhile.
        console.warn('[vneid:register] status check failed', {
          registrationId: row.id,
          reason:
            error instanceof CsignError ? `${error.kind} ${error.code ?? ''}`.trim() : 'error',
        });
      }
    }
  }
  return viewOf(deps.store.getRegistration(row.id) ?? row);
}
