'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import { TextField } from '@/components/TextField';
import { InlineSpinner } from '@/components/signing/Spinners';
import { VneidRegisterModal } from '@/components/vneid/VneidRegisterModal';
import { VneidRegistrationCard } from '@/components/vneid/VneidRegistrationCard';
import { isPlausibleCitizenPid, isRegistrationOpen } from '@/lib/vneid/client/polling';
import { useVneidRegistration } from '@/lib/vneid/client/useVneidRegistration';
import {
  fetchVneidCredentials,
  VneidApiError,
  type VneidCredential,
} from '@/lib/vneid/client/vneidApi';

/** Server limit (lib/pdfSign/limits.ts MAX_FIELDS). */
export const VNEID_MAX_FIELDS = 10;

export interface VneidSignerValue {
  citizenPid: string;
  consent: boolean;
  /** The certificate picked from the list; only its id is ever sent. */
  credentialId: string | null;
}

export const EMPTY_VNEID_SIGNER: VneidSignerValue = {
  citizenPid: '',
  consent: false,
  credentialId: null,
};

export const isVneidSignerReady = (value: VneidSignerValue) =>
  isPlausibleCitizenPid(value.citizenPid) && value.consent && value.credentialId !== null;

/**
 * VNeID signer: CCCD + consent -> "Get certificates" -> pick one. The list
 * carries no personal data (the server never returns the holder's name), so
 * it shows the issuing CA, validity and key, and why a certificate cannot
 * sign. A certificate under the CSign UAT test root is marked as such.
 *
 * A CCCD without a certificate is offered to register one
 * (VneidRegisterModal). The registration's status is kept by the server per
 * CCCD, so "Get certificates" also asks for it: after a reload it shows up
 * again, and once it completes the new certificate is fetched and picked.
 */
export function VneidSignerPanel({
  value,
  onChange,
  disabled,
}: {
  value: VneidSignerValue;
  onChange: (value: VneidSignerValue) => void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const language = i18n.language?.startsWith('en') ? 'en' : 'vi';
  const [credentials, setCredentials] = useState<VneidCredential[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noCertificate, setNoCertificate] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const {
    registration,
    pollError,
    refresh: refreshRegistration,
    track: trackRegistration,
    clear: clearRegistration,
  } = useVneidRegistration({
    citizenPid: value.citizenPid,
    language,
    // The new certificate is ready: list again and pick it.
    onCompleted: (credentialId) => void load(credentialId),
  });
  const registrationOpen = registration !== null && isRegistrationOpen(registration.status);

  const pidComplete = value.citizenPid.length === 12;
  const pidValid = isPlausibleCitizenPid(value.citizenPid);
  const pidError = pidComplete && !pidValid ? t('vneid.cccdError') : null;
  const canFetch = pidValid && value.consent && !loading && !disabled;

  const changePid = (raw: string) => {
    const digits = raw.replace(/[^0-9]/g, '').slice(0, 12);
    if (digits === value.citizenPid) return;
    setCredentials(null);
    setError(null);
    setNotice(null);
    setNoCertificate(false);
    setShowRegister(false);
    clearRegistration();
    onChange({ ...value, citizenPid: digits, credentialId: null });
  };

  /** Certificates and registration of the CCCD; `select` picks a certificate when listed. */
  async function load(select?: string) {
    setLoading(true);
    setError(null);
    setNotice(null);
    const [listed, registered] = await Promise.allSettled([
      fetchVneidCredentials(value.citizenPid, language),
      refreshRegistration(),
    ]);
    const waiting =
      registered.status === 'fulfilled' &&
      registered.value !== null &&
      isRegistrationOpen(registered.value.status);
    if (listed.status === 'fulfilled') {
      const list = listed.value;
      setCredentials(list);
      setNoCertificate(false);
      const usable = list.filter((credential) => credential.usable);
      const picked = select && usable.some((credential) => credential.credentialId === select);
      if (select && !picked) setNotice(t('vneid.register.notListedYet'));
      onChange({
        ...value,
        credentialId: picked ? select : usable.length === 1 ? usable[0]!.credentialId : null,
      });
    } else {
      setCredentials(null);
      onChange({ ...value, credentialId: null });
      const caught: unknown = listed.reason;
      if (caught instanceof VneidApiError && caught.code === 'VNEID_NO_CERTIFICATE') {
        setNoCertificate(true);
        if (select) setNotice(t('vneid.register.notListedYet'));
        else if (!waiting) setShowRegister(true);
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
    setLoading(false);
  }

  const formatDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(language === 'en' ? 'en-GB' : 'vi-VN') : '?';

  return (
    <div className="space-y-2">
      <TextField
        id="vneid-cccd"
        label={t('vneid.cccdLabel')}
        value={value.citizenPid}
        onChange={changePid}
        hint={t('vneid.cccdHint')}
        error={pidError}
        required
        inputMode="numeric"
        autoComplete="off"
        maxLength={12}
        placeholder="001099012345"
        disabled={disabled}
      />

      <label className="flex items-start gap-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          checked={value.consent}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, consent: event.target.checked })}
        />
        <span>{t('vneid.consent')}</span>
      </label>

      <button
        type="button"
        onClick={() => void load()}
        disabled={!canFetch}
        className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-primary bg-white px-4 py-1.5 text-sm font-semibold text-primary shadow-sm transition hover:bg-surface-soft-strong disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading && <InlineSpinner />}
        {loading
          ? t('vneid.fetchingCredentials')
          : credentials
            ? t('vneid.refetchCredentials')
            : t('vneid.fetchCredentials')}
      </button>

      {error && (
        <div className="rounded-md border border-error-border bg-error-bg px-3 py-2 text-xs text-error-text">
          {error}
        </div>
      )}
      {notice && <p className="text-xs text-text-muted">{notice}</p>}

      {registration && (
        <VneidRegistrationCard
          registration={registration}
          pollError={pollError}
          onRegisterAgain={() => setShowRegister(true)}
          disabled={disabled}
        />
      )}

      {noCertificate && registration === null && (
        <div className="rounded-lg border border-border-subtle bg-surface-soft px-3 py-2.5 text-xs">
          <p className="font-semibold text-text-main">{t('vneid.register.noCertificateTitle')}</p>
          <p className="mt-0.5 text-text-muted">{t('vneid.register.noCertificateText')}</p>
          <button
            type="button"
            onClick={() => setShowRegister(true)}
            disabled={disabled}
            className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t('vneid.register.openButton')}
          </button>
        </div>
      )}

      {credentials && (
        <div>
          <span className="block text-xs font-medium text-text-main">
            {t('vneid.credentialsTitle')}
          </span>
          <div
            role="radiogroup"
            aria-label={t('vneid.credentialsTitle')}
            className="mt-1 space-y-1.5"
          >
            {credentials.map((credential) => {
              const active = value.credentialId === credential.credentialId;
              return (
                <button
                  key={credential.credentialId}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled || !credential.usable}
                  onClick={() => onChange({ ...value, credentialId: credential.credentialId })}
                  className={`flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs transition disabled:cursor-not-allowed ${
                    active
                      ? 'border-primary bg-surface-soft'
                      : credential.usable
                        ? 'border-border-subtle bg-white hover:border-primary'
                        : 'border-border-subtle bg-gray-50 opacity-60'
                  }`}
                >
                  <Icon
                    icon={active ? 'lucide:circle-dot' : 'lucide:circle'}
                    className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${active ? 'text-primary' : 'text-text-muted'}`}
                  />
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="block truncate font-semibold text-text-main">
                      {t('vneid.issuedBy', { issuer: credential.issuer ?? '?' })}
                    </span>
                    <span className="block text-text-muted">
                      {t('vneid.validity', {
                        from: formatDate(credential.validFrom),
                        to: formatDate(credential.validTo),
                      })}
                      {credential.keyBits
                        ? ` · ${t('vneid.keyBits', { bits: credential.keyBits })}`
                        : ''}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-text-muted">
                      {credential.credentialId}
                    </span>
                    {!credential.usable && credential.reason && (
                      <span className="block font-medium text-error-text">
                        {t(`vneid.unusable.${credential.reason}`)}
                      </span>
                    )}
                    {credential.usable && !credential.chainVerified && (
                      <span
                        className="mt-0.5 inline-flex rounded-full bg-warning-bg px-2 py-0.5 text-[10px] font-medium text-warning-text"
                        title={t('vneid.chainMismatchHint')}
                      >
                        {t('vneid.chainMismatch')}
                      </span>
                    )}
                    {credential.usable && credential.chainVerified && !credential.rootTrusted && (
                      <span
                        className="mt-0.5 inline-flex rounded-full bg-warning-bg px-2 py-0.5 text-[10px] font-medium text-warning-text"
                        title={t('vneid.testRootHint')}
                      >
                        {t('vneid.testRoot')}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          {credentials.every((credential) => !credential.usable) ? (
            <p className="mt-1 text-xs text-error-text">
              {t('vneid.noUsable')}
              {!registrationOpen && (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={() => setShowRegister(true)}
                    disabled={disabled}
                    className="font-semibold text-primary underline disabled:opacity-60"
                  >
                    {t('vneid.register.openButton')}
                  </button>
                </>
              )}
            </p>
          ) : (
            value.credentialId === null && (
              <p className="mt-1 text-xs text-text-muted">{t('vneid.selectCredential')}</p>
            )
          )}
        </div>
      )}

      {showRegister && (
        <VneidRegisterModal
          citizenPid={value.citizenPid}
          language={language}
          onClose={() => setShowRegister(false)}
          onRegistered={(started) => {
            trackRegistration(started);
            setShowRegister(false);
          }}
        />
      )}
    </div>
  );
}
