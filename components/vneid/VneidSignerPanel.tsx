'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import { TextField } from '@/components/TextField';
import { InlineSpinner } from '@/components/signing/Spinners';
import { CredentialCard } from '@/components/vneid/CredentialCard';

import { buttonClass, Notice } from '@/components/vneid/ui';
import { VneidCertificateModal } from '@/components/vneid/VneidCertificateModal';
import { VneidRegisterModal } from '@/components/vneid/VneidRegisterModal';
import { VneidRegistrationCard } from '@/components/vneid/VneidRegistrationCard';
import { isPlausibleCitizenPid, isRegistrationOpen } from '@/lib/vneid/client/polling';
import { useVneidRegistration } from '@/lib/vneid/client/useVneidRegistration';
import {
  fetchVneidCredentials,
  VneidApiError,
  type VneidCredential,
  type VneidRegistration,
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

/** Finished registrations whose card was already shown once, kept in this
 * browser (provider and start time only, nothing about the person). */
const SEEN_REGISTRATIONS = 'kysoqr.vneid.seenRegistrations';
const registrationKey = (registration: VneidRegistration) =>
  `${registration.provider}:${registration.createdAt}`;

function seenRegistrations(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SEEN_REGISTRATIONS) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function markRegistrationSeen(key: string) {
  try {
    const kept = seenRegistrations()
      .filter((item) => item !== key)
      .slice(0, 19);
    window.localStorage.setItem(SEEN_REGISTRATIONS, JSON.stringify([key, ...kept]));
  } catch {
    // Storage blocked: the card simply shows again next time.
  }
}

/**
 * VNeID signer: CCCD + consent -> "Get certificates" -> pick one. The list
 * carries no personal data (the server never returns the holder's name), so
 * it shows the issuing CA, validity and key, and why a certificate cannot
 * sign. A certificate under the CSign UAT test root is marked as such.
 *
 * A CCCD without a certificate is offered to register one
 * (VneidRegisterModal); one that has certificates can still register another
 * (the link under "Get certificates", or the certificate picker). The
 * registration's status is kept by the server per CCCD, so "Get certificates" also asks for it: after a reload it shows up
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
  const [hiddenRegistration, setHiddenRegistration] = useState<string | null>(null);
  const [registerSkipIntro, setRegisterSkipIntro] = useState(false);
  const [showCertModal, setShowCertModal] = useState(false);
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
  // A finished registration's card is shown once; later lookups leave it out.
  const shownRegistration =
    registration &&
    !(registration.status === 'COMPLETED' && registrationKey(registration) === hiddenRegistration)
      ? registration
      : null;

  const pidComplete = value.citizenPid.length === 12;
  const pidValid = isPlausibleCitizenPid(value.citizenPid);
  const pidError = pidComplete && !pidValid ? t('vneid.cccdError') : null;
  const canFetch = pidValid && value.consent && !loading && !disabled;
  const canRegister = pidValid && value.consent && !disabled && !registrationOpen;
  // The notices below already offer to register when there is nothing to sign with.
  const offersRegister =
    (noCertificate && shownRegistration === null) ||
    (credentials !== null && credentials.every((credential) => !credential.usable));

  /** The registration popup; `skipIntro` when the CCCD may already have certificates. */
  const openRegister = (skipIntro = false) => {
    setShowCertModal(false);
    setRegisterSkipIntro(skipIntro);
    setShowRegister(true);
  };

  const changePid = (raw: string) => {
    const digits = raw.replace(/[^0-9]/g, '').slice(0, 12);
    if (digits === value.citizenPid) return;
    setCredentials(null);
    setError(null);
    setNotice(null);
    setNoCertificate(false);
    setShowRegister(false);
    setShowCertModal(false);
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
    const finished =
      registered.status === 'fulfilled' && registered.value?.status === 'COMPLETED'
        ? registered.value
        : null;
    if (finished) {
      const key = registrationKey(finished);
      // Shown when it completes (`select`) or on the first lookup after that.
      if (!select && seenRegistrations().includes(key)) setHiddenRegistration(key);
      else markRegistrationSeen(key);
    }
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
      if (list.length > 0) {
        setShowCertModal(true);
      }
    } else {
      setCredentials(null);
      onChange({ ...value, credentialId: null });
      const caught: unknown = listed.reason;
      if (caught instanceof VneidApiError && caught.code === 'VNEID_NO_CERTIFICATE') {
        setNoCertificate(true);
        if (select) setNotice(t('vneid.register.notListedYet'));
        else if (!waiting) openRegister();
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
    setLoading(false);
  }

  const formatDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(language === 'en' ? 'en-GB' : 'vi-VN') : '?';

  const selectedCredential = credentials?.find(
    (credential) => credential.credentialId === value.credentialId
  );

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
        className={`${buttonClass('secondary')} w-full`}
      >
        {loading && <InlineSpinner />}
        {loading
          ? t('vneid.fetchingCredentials')
          : credentials
            ? t('vneid.refetchCredentials')
            : t('vneid.fetchCredentials')}
      </button>

      {!offersRegister && (
        <p className="text-center text-[11px] text-text-muted">
          {t('vneid.register.newPrompt')}{' '}
          <button
            type="button"
            onClick={() => openRegister(true)}
            disabled={!canRegister}
            className="font-semibold text-primary hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
          >
            {t('vneid.register.openButton')}
          </button>
        </p>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {notice && <p className="text-xs text-text-muted">{notice}</p>}

      {shownRegistration && (
        <VneidRegistrationCard
          registration={shownRegistration}
          pollError={pollError}
          onRegisterAgain={() => openRegister()}
          disabled={disabled}
        />
      )}

      {noCertificate && shownRegistration === null && (
        <Notice tone="info">
          <p className="font-semibold text-text-main">{t('vneid.register.noCertificateTitle')}</p>
          <p className="mt-0.5 text-text-muted">{t('vneid.register.noCertificateText')}</p>
          <button
            type="button"
            onClick={() => openRegister()}
            disabled={disabled}
            className={`mt-2 ${buttonClass('primary', 'sm')}`}
          >
            {t('vneid.register.openButton')}
          </button>
        </Notice>
      )}

      {credentials && (
        <div className="space-y-1.5">
          {credentials.every((credential) => !credential.usable) ? (
            <Notice tone="info">
              <p className="font-medium text-error-text">
                {t('vneid.noUsable')}
                {!registrationOpen && (
                  <>
                    {' '}
                    <button
                      type="button"
                      onClick={() => openRegister()}
                      disabled={disabled}
                      className="font-semibold text-primary underline disabled:opacity-60"
                    >
                      {t('vneid.register.openButton')}
                    </button>
                  </>
                )}
              </p>
            </Notice>
          ) : (
            <div>
              <div className="flex items-center justify-between pb-1">
                <span className="block text-xs font-medium text-text-main">
                  {t('vneid.selectedCredentialLabel')}
                </span>
                <button
                  type="button"
                  onClick={() => setShowCertModal(true)}
                  disabled={disabled}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline disabled:opacity-60"
                >
                  <span>{t('vneid.changeCredential')}</span>
                  <Icon icon="lucide:chevron-right" className="h-3.5 w-3.5" />
                </button>
              </div>

              {selectedCredential ? (
                <CredentialCard
                  credential={selectedCredential}
                  formatDate={formatDate}
                  variant="button"
                  selected
                  disabled={disabled}
                  onClick={() => setShowCertModal(true)}
                  action={
                    <span className="text-[11px] font-medium text-primary transition-transform group-hover:translate-x-0.5">
                      {t('vneid.changeCredential')} →
                    </span>
                  }
                />
              ) : (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setShowCertModal(true)}
                  className="flex w-full items-center justify-between rounded-xl border border-dashed border-primary/60 bg-surface-soft/60 px-3.5 py-2.5 text-left text-xs text-primary transition hover:border-primary hover:bg-surface-soft disabled:cursor-not-allowed"
                >
                  <span className="font-medium">
                    {t('vneid.selectCertPrompt', { count: credentials.length })}
                  </span>
                  <Icon icon="lucide:chevron-right" className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {showCertModal && credentials && (
        <VneidCertificateModal
          credentials={credentials}
          selectedCredentialId={value.credentialId}
          onSelect={(credentialId) => onChange({ ...value, credentialId })}
          onClose={() => setShowCertModal(false)}
          formatDate={formatDate}
          onRegister={registrationOpen ? undefined : () => openRegister(true)}
        />
      )}

      {showRegister && (
        <VneidRegisterModal
          citizenPid={value.citizenPid}
          language={language}
          skipIntro={registerSkipIntro}
          hasCertificates={credentials !== null && credentials.length > 0}
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
