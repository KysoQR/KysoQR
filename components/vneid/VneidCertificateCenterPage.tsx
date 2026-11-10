'use client';

import '@/lib/i18n/init';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { InlineSpinner } from '@/components/signing/Spinners';
import { CredentialCard } from '@/components/vneid/CredentialCard';
import { NoCertificateNotice } from '@/components/vneid/NoCertificateNotice';
import { formatPrice, PackPicker } from '@/components/vneid/PackPicker';
import { ProviderGrid } from '@/components/vneid/ProviderGrid';
import { RegistrationFormFields } from '@/components/vneid/RegistrationFormFields';
import { SelectedPackBanner } from '@/components/vneid/SelectedPackBanner';
import { Badge, buttonClass, Notice, type Tone } from '@/components/vneid/ui';
import { isPlausibleCitizenPid, isRegistrationOpen } from '@/lib/vneid/client/polling';
import { useRegistrationForm } from '@/lib/vneid/client/useRegistrationForm';
import { useVneidRegistration } from '@/lib/vneid/client/useVneidRegistration';
import {
  fetchVneidCredentials,
  fetchVneidProviders,
  startVneidRegistration,
  VneidApiError,
  type VneidCredential,
  type VneidLanguage,
  type VneidProvider,
  type VneidRegistrationStatus,
  type VneidServicePack,
} from '@/lib/vneid/client/vneidApi';

/** Provider -> pack -> form -> activation in VNeID. */
type WizardStep = 1 | 2 | 3 | 4;
type StepState = 'current' | 'done' | 'todo';

/** Grows with the screen up to 1600px; the header gets the same width so
 * logo and menu line up with the content. */
const PAGE_WIDTH = 'max-w-[1600px]';
const SECTION = 'rounded-2xl border border-border-subtle bg-white p-5 shadow-2xs sm:p-6';

const STATUS_TONE: Record<VneidRegistrationStatus, Tone> = {
  PENDING: 'warning',
  ISSUED: 'warning',
  COMPLETED: 'success',
  FAILED: 'error',
  REJECTED: 'error',
  EXPIRED: 'error',
};

function StepButton({
  number,
  label,
  title,
  state,
  onClick,
  disabled,
}: {
  number: number;
  label: string;
  title: string;
  state: StepState;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-2.5 text-left disabled:cursor-not-allowed"
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition ${
          state === 'current'
            ? 'bg-primary text-white ring-4 ring-primary/15'
            : state === 'done'
              ? 'bg-surface-soft-strong text-primary-strong'
              : 'bg-gray-100 text-text-muted'
        }`}
      >
        {state === 'done' ? <Icon icon="lucide:check" className="h-3.5 w-3.5" /> : number}
      </span>
      <span className="hidden sm:block">
        <span className="block text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          {label}
        </span>
        <span
          className={`block text-sm font-bold ${
            state === 'current' ? 'text-text-main' : 'text-text-secondary'
          }`}
        >
          {title}
        </span>
      </span>
    </button>
  );
}

function TimelineItem({
  number,
  state,
  title,
  highlight = state === 'current',
  children,
}: {
  number: number;
  state: StepState;
  title: string;
  highlight?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      className={`flex items-start gap-3 rounded-xl border p-3.5 ${
        highlight ? 'border-primary bg-surface-soft' : 'border-border-subtle bg-white'
      }`}
    >
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
          state === 'todo' ? 'bg-gray-100 text-text-muted' : 'bg-primary text-white'
        }`}
      >
        {state === 'done' ? <Icon icon="lucide:check" className="h-3.5 w-3.5" /> : number}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-bold text-text-main">{title}</p>
        {children}
      </div>
    </div>
  );
}

export function VneidCertificateCenterPage() {
  const { t, i18n } = useTranslation();
  const language: VneidLanguage = i18n.language?.startsWith('en') ? 'en' : 'vi';
  const freeLabel = t('vneid.register.free');

  const [step, setStep] = useState<WizardStep>(1);

  // Quick lookup
  const [lookupPid, setLookupPid] = useState('');
  const [lookupOpen, setLookupOpen] = useState(false);
  /** The CCCD the shown results are for (the box may already hold another). */
  const [lookedUpPid, setLookedUpPid] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupCreds, setLookupCreds] = useState<VneidCredential[] | null>(null);
  const [lookupNoCert, setLookupNoCert] = useState(false);
  const stepsRef = useRef<HTMLDivElement>(null);

  // Step 1: provider and pack
  const [providers, setProviders] = useState<VneidProvider[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<VneidProvider | null>(null);
  const [selectedPack, setSelectedPack] = useState<VneidServicePack | null>(null);

  // Step 2: registration form
  const [formPid, setFormPid] = useState('');
  const [formPidError, setFormPidError] = useState<string | null>(null);
  const registrationForm = useRegistrationForm();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Step 3 and the registration being followed
  const activeCitizenPid = step === 4 ? formPid || lookupPid : lookupPid || formPid;
  const {
    registration,
    pollError,
    refresh: refreshRegistration,
    track: trackRegistration,
    clear: clearRegistration,
  } = useVneidRegistration({
    citizenPid: activeCitizenPid,
    language,
    onCompleted: () => {
      if (isPlausibleCitizenPid(activeCitizenPid)) {
        void fetchVneidCredentials(activeCitizenPid, language)
          .then((list) => {
            setLookupCreds(list);
            setLookupNoCert(false);
          })
          .catch(() => undefined);
      }
    },
  });

  // Loads the providers on arrival, again when the language changes or on
  // "retry" (providersAttempt). State is only set once the answer is in, and
  // an answer for a language no longer shown is dropped.
  const [providersAttempt, setProvidersAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    fetchVneidProviders(language)
      .then((list) => {
        if (current) setProviders(list);
      })
      .catch((caught: unknown) => {
        if (current) setProvidersError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      current = false;
    };
  }, [language, providersAttempt]);

  /** Picking a provider shows its packs; another provider drops the pack picked before. */
  const chooseProvider = (item: VneidProvider) => {
    if (item !== selectedProvider) setSelectedPack(null);
    setSelectedProvider(item);
    setStep(2);
  };

  const retryProviders = () => {
    setProvidersError(null);
    setProviders(null);
    setProvidersAttempt((attempt) => attempt + 1);
  };

  const handleLookupPidChange = (raw: string) => {
    const digits = raw.replace(/[^0-9]/g, '').slice(0, 12);
    setLookupPid(digits);
    if (!formPid) setFormPid(digits);
  };

  const handleQuickLookup = async () => {
    // The button closes the results of the number in the box; another number
    // is looked up straight away.
    if (lookupOpen && lookupPid === lookedUpPid) {
      setLookupOpen(false);
      return;
    }
    setLookedUpPid(lookupPid);
    setLookupCreds(null);
    setLookupNoCert(false);
    setLookupOpen(true);
    if (!isPlausibleCitizenPid(lookupPid)) {
      setLookupError(t('vneid.cccdError'));
      return;
    }
    setLookupLoading(true);
    setLookupError(null);
    setFormPid(lookupPid);

    const [listed] = await Promise.allSettled([
      fetchVneidCredentials(lookupPid, language),
      refreshRegistration(),
    ]);

    if (listed.status === 'fulfilled') {
      setLookupCreds(listed.value);
      setLookupNoCert(listed.value.length === 0);
    } else {
      setLookupCreds(null);
      const caught: unknown = listed.reason;
      if (caught instanceof VneidApiError && caught.code === 'VNEID_NO_CERTIFICATE') {
        setLookupNoCert(true);
      } else {
        setLookupError(caught instanceof Error ? caught.message : String(caught));
      }
    }
    setLookupLoading(false);
  };

  const handleFormPidChange = (raw: string) => {
    setFormPid(raw.replace(/[^0-9]/g, '').slice(0, 12));
    setFormPidError(null);
  };

  const handleSubmitRegistration = async () => {
    if (!selectedProvider || !selectedPack) return;
    const validPid = isPlausibleCitizenPid(formPid);
    const formOk = registrationForm.validate();
    if (!validPid) setFormPidError(t('vneid.cccdError'));
    if (!validPid || !formOk) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const started = await startVneidRegistration({
        citizenPid: formPid,
        provider: selectedProvider.provider,
        servicePackCode: selectedPack.code,
        servicePackName: selectedPack.name,
        userInfo: registrationForm.userInfo(),
        language,
      });
      setLookupPid(formPid);
      trackRegistration(started);
      setStep(4);
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const formatDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(language === 'en' ? 'en-GB' : 'vi-VN') : '?';

  const registrationOpen = registration !== null && isRegistrationOpen(registration.status);
  const status = registration?.status;
  /** Shares the details (1), activates the issued certificate (2), done (3). */
  const stageState = (stage: 1 | 2 | 3): StepState => {
    if (status === 'COMPLETED') return 'done';
    const reached = status === 'ISSUED' ? 2 : status === 'PENDING' ? 1 : 0;
    return stage < reached ? 'done' : stage === reached ? 'current' : 'todo';
  };

  const steps = [
    { number: 1, title: t('vneidPage.step1Title'), enabled: true },
    { number: 2, title: t('vneidPage.step2Title'), enabled: selectedProvider !== null },
    {
      number: 3,
      title: t('vneidPage.step3Title'),
      enabled: selectedProvider !== null && selectedPack !== null,
    },
    { number: 4, title: t('vneidPage.step4Title'), enabled: registration !== null },
  ] as const;

  return (
    <div className="flex min-h-screen flex-col bg-page-bg text-text-main">
      <Header maxWidthClassName={PAGE_WIDTH} />

      <main className={`mx-auto w-full flex-1 px-4 pb-4 pt-5 sm:px-6 ${PAGE_WIDTH}`}>
        {/* Hero + quick lookup + the 4 steps, in one card to keep the steps below in view */}
        <div className={`mb-4 ${SECTION}`}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <Badge tone="success">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                {t('vneidPage.badge')}
              </Badge>
              <h1 className="mt-1.5 text-xl font-bold tracking-tight text-text-main sm:text-2xl">
                {t('vneidPage.title')}
              </h1>
              <p className="mt-0.5 text-xs text-text-secondary sm:text-sm">
                {t('vneidPage.subtitle')}
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                type="text"
                inputMode="numeric"
                maxLength={12}
                value={lookupPid}
                onChange={(e) => handleLookupPidChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !lookupLoading) void handleQuickLookup();
                }}
                placeholder={t('vneidPage.lookupPlaceholder')}
                aria-label={t('vneid.cccdLabel')}
                className="w-full rounded-xl border border-border-subtle bg-surface-soft/50 px-3.5 py-2 font-mono text-xs text-text-main outline-none focus:border-primary focus:bg-white focus:ring-2 focus:ring-primary/20 sm:w-56"
              />
              <button
                type="button"
                onClick={() => void handleQuickLookup()}
                disabled={lookupLoading}
                className={buttonClass('secondary', 'sm')}
              >
                {lookupLoading ? (
                  <InlineSpinner />
                ) : (
                  <Icon icon="lucide:search" className="h-3.5 w-3.5" />
                )}
                {lookupOpen && lookupPid === lookedUpPid
                  ? t('vneidPage.lookupHideButton')
                  : t('vneidPage.lookupButton')}
              </button>
            </div>
          </div>

          {lookupOpen && (
            <div className="mt-4 border-t border-border-subtle pt-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-text-main">
                  {t('vneidPage.lookupResultTitle')}{' '}
                  <span className="font-mono text-primary-strong">{lookedUpPid || '—'}</span>
                </p>
                {lookupCreds && (
                  <Badge tone="success">
                    {t('vneidPage.lookupCount', { count: lookupCreds.length })}
                  </Badge>
                )}
              </div>

              {lookupLoading && (
                <p className="mt-3 flex items-center gap-2 text-xs text-text-muted">
                  <InlineSpinner />
                  {t('vneid.fetchingCredentials')}
                </p>
              )}

              {lookupError && (
                <Notice tone="error" className="mt-3">
                  {lookupError}
                </Notice>
              )}

              {!lookupLoading && lookupNoCert && (
                <NoCertificateNotice
                  className="mt-3"
                  text={t('vneidPage.lookupNoCert')}
                  onRegister={
                    registrationOpen
                      ? undefined
                      : () => {
                          setStep(1);
                          stepsRef.current?.scrollIntoView({
                            behavior: 'smooth',
                            block: 'nearest',
                          });
                        }
                  }
                />
              )}

              {!lookupLoading && lookupCreds && lookupCreds.length > 0 && (
                <div className="mt-3 grid gap-2.5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {lookupCreds.map((cred) => (
                    <CredentialCard
                      key={cred.credentialId}
                      credential={cred}
                      formatDate={formatDate}
                      action={
                        cred.usable && (
                          <Link href="/" className={buttonClass('primary', 'sm')}>
                            {t('vneidPage.signNow')}
                          </Link>
                        )
                      }
                    />
                  ))}
                </div>
              )}

              {registration && (
                <Notice
                  tone="warning"
                  className="mt-3 flex flex-wrap items-center justify-between gap-2"
                >
                  <div className="flex items-center gap-2.5">
                    {registrationOpen ? (
                      <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-warning-strong" />
                    ) : (
                      <Icon icon="lucide:info" className="h-4 w-4 text-warning-strong" />
                    )}
                    <div>
                      <p className="font-semibold">
                        {t('vneidPage.lookupActiveReg')} ({registration.providerName} ·{' '}
                        {registration.servicePackName})
                      </p>
                      <p className="text-[11px]">
                        {t(`vneid.register.status.${registration.status}`)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setStep(4)}
                    className={buttonClass('ghost', 'sm')}
                  >
                    {t('vneidPage.lookupViewReg')}
                  </button>
                </Notice>
              )}
            </div>
          )}

          <div
            ref={stepsRef}
            className="mt-3 flex items-center justify-between border-t border-border-subtle pt-3"
          >
            {steps.map((item, index) => (
              <Fragment key={item.number}>
                {index > 0 && <div className="mx-2 h-px flex-1 bg-border-subtle sm:mx-4" />}
                <StepButton
                  number={item.number}
                  label={t('vneidPage.stepOf', { step: item.number })}
                  title={item.title}
                  state={step === item.number ? 'current' : step > item.number ? 'done' : 'todo'}
                  onClick={() => {
                    if (item.enabled) setStep(item.number);
                  }}
                  disabled={!item.enabled}
                />
              </Fragment>
            ))}
          </div>
        </div>

        {/* STEP 1: provider -- picking one moves on to its packs */}
        {step === 1 && (
          <div className={SECTION}>
            <div className="mb-3.5">
              <h2 className="text-sm font-bold text-text-main">{t('vneidPage.providerHeading')}</h2>
              <p className="text-xs text-text-muted">
                {t('vneidPage.providerSubheading')}. {t('vneidPage.pickProviderHint')}
              </p>
            </div>

            {providers === null && !providersError && (
              <p className="flex items-center gap-2 py-4 text-xs text-text-muted">
                <InlineSpinner />
                {t('vneid.register.loadingProviders')}
              </p>
            )}

            {providersError && (
              <Notice tone="error">
                {providersError}{' '}
                <button type="button" onClick={retryProviders} className="font-semibold underline">
                  {t('common.retry')}
                </button>
              </Notice>
            )}

            {providers?.length === 0 && (
              <p className="py-4 text-xs text-text-muted">{t('vneid.register.noProviders')}</p>
            )}

            {providers && providers.length > 0 && (
              <ProviderGrid
                providers={providers}
                selected={selectedProvider}
                onSelect={chooseProvider}
                columns="sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6"
              />
            )}
          </div>
        )}

        {/* STEP 2: pack of the chosen provider */}
        {step === 2 && selectedProvider && (
          <div className={SECTION}>
            <SelectedPackBanner
              provider={selectedProvider}
              pack={null}
              language={language}
              onChange={() => setStep(1)}
              changeLabel={t('vneidPage.changeProvider')}
            />
            <div className="mt-4">
              <PackPicker
                provider={selectedProvider}
                selected={selectedPack}
                onSelect={setSelectedPack}
                language={language}
                columns="sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
                heading={
                  <>
                    <h2 className="text-sm font-bold text-text-main">
                      {t('vneidPage.packHeading', { provider: selectedProvider.name })}
                    </h2>
                    <p className="text-xs text-text-muted">{t('vneidPage.packSubheading')}</p>
                  </>
                }
              />
            </div>

            <div className="mt-5 flex flex-col gap-3 border-t border-border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
              <button
                type="button"
                onClick={() => setStep(1)}
                className={`self-start ${buttonClass('ghost', 'sm')}`}
              >
                {t('vneidPage.backToProviders')}
              </button>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                {selectedPack && (
                  <span className="text-xs text-text-secondary">
                    {t('vneidPage.selectedSummary')}{' '}
                    <strong className="text-text-main">{selectedPack.name}</strong>{' '}
                    <span className="font-semibold text-primary-strong">
                      ({formatPrice(selectedPack, language, freeLabel)})
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  disabled={!selectedPack}
                  onClick={() => setStep(3)}
                  className={buttonClass('primary')}
                >
                  {t('vneidPage.continueToForm')}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* STEP 3: registration form */}
        {step === 3 && selectedProvider && selectedPack && (
          <div className={SECTION}>
            <SelectedPackBanner
              provider={selectedProvider}
              pack={selectedPack}
              language={language}
              onChange={() => setStep(2)}
              changeLabel={t('vneidPage.changePack')}
              disabled={submitting}
            />
            <p className="mb-3 mt-3 text-xs text-text-muted">{t('vneid.register.formHint')}</p>

            <RegistrationFormFields
              state={registrationForm}
              idPrefix="vneid-page"
              citizenPid={{ value: formPid, onChange: handleFormPidChange, error: formPidError }}
              disabled={submitting}
            />

            {submitError && (
              <Notice tone="error" className="mt-3">
                {submitError}
              </Notice>
            )}

            <div className="mt-3 flex items-center justify-between gap-2 border-t border-border-subtle pt-3">
              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={submitting}
                className={buttonClass('ghost', 'sm')}
              >
                {t('vneidPage.backToPacks')}
              </button>
              <button
                type="button"
                onClick={() => void handleSubmitRegistration()}
                disabled={!registrationForm.consent || submitting}
                className={buttonClass('primary')}
              >
                {submitting && <InlineSpinner />}
                {submitting ? t('vneid.register.submitting') : t('vneidPage.submitToVneid')}
              </button>
            </div>
          </div>
        )}

        {/* STEP 4: activate in VNeID */}
        {step === 4 && (
          <div className="grid gap-5 lg:grid-cols-12">
            <div className={`lg:col-span-7 ${SECTION}`}>
              {registration ? (
                <>
                  <div className="border-b border-border-subtle pb-4">
                    <Badge tone={STATUS_TONE[registration.status]}>
                      {registrationOpen && (
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning-strong" />
                      )}
                      {t(`vneid.register.badge.${registration.status}`)}
                    </Badge>
                    <h2 className="mt-2 text-base font-bold text-text-main">
                      {t('vneid.register.cardTitle')}: {registration.providerName}
                    </h2>
                    <p className="text-xs text-text-muted">
                      {registration.servicePackName} · CCCD:{' '}
                      <span className="font-mono font-semibold text-text-main">
                        {activeCitizenPid}
                      </span>
                    </p>
                  </div>

                  <div className="mt-5 space-y-3">
                    <TimelineItem
                      number={1}
                      state={stageState(1)}
                      title={t('vneid.register.status.PENDING')}
                    >
                      <p className="mt-0.5 text-xs text-text-secondary">
                        {t('vneid.register.waitStep2')}
                      </p>
                    </TimelineItem>
                    <TimelineItem
                      number={2}
                      state={stageState(2)}
                      title={t('vneid.register.status.ISSUED')}
                    >
                      <p className="mt-0.5 text-xs text-text-secondary">
                        {t('vneid.register.waitStep3')}
                      </p>
                    </TimelineItem>
                    <TimelineItem
                      number={3}
                      state={stageState(3)}
                      highlight={registration.status === 'COMPLETED'}
                      title={t('vneid.register.status.COMPLETED')}
                    >
                      {registration.serialNumber && (
                        <p className="mt-1 truncate font-mono text-[11px] text-primary-strong">
                          Serial: {registration.serialNumber}
                        </p>
                      )}
                    </TimelineItem>
                  </div>

                  {!registrationOpen && registration.status !== 'COMPLETED' && (
                    <Notice tone="error" className="mt-4">
                      <p className="font-bold">
                        {t(`vneid.register.status.${registration.status}`)}
                      </p>
                      {registration.reason && (
                        <p className="mt-0.5">
                          {t(`vneid.register.reason.${registration.reason}`)}
                        </p>
                      )}
                    </Notice>
                  )}

                  {pollError && <p className="mt-3 text-xs text-error-text">{pollError}</p>}

                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
                    <button
                      type="button"
                      onClick={() => {
                        clearRegistration();
                        setStep(1);
                      }}
                      className={buttonClass('ghost', 'sm')}
                    >
                      {t('vneidPage.registerAnother')}
                    </button>
                    {registration.status === 'COMPLETED' && (
                      <Link href="/" className={buttonClass('primary')}>
                        {t('vneidPage.signNow')}
                      </Link>
                    )}
                  </div>
                </>
              ) : (
                <div className="py-8 text-center">
                  <p className="text-sm text-text-muted">{t('vneid.register.noCertificateText')}</p>
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className={`mt-4 ${buttonClass('primary', 'sm')}`}
                  >
                    {t('vneid.register.openButton')}
                  </button>
                </div>
              )}
            </div>

            <div className={`lg:col-span-5 ${SECTION}`}>
              <Badge tone="success">
                <Icon icon="lucide:smartphone" className="h-3.5 w-3.5" />
                {t('vneidPage.phoneGuideBadge')}
              </Badge>
              <h3 className="mt-2 text-sm font-bold text-text-main">
                {t('vneidPage.phoneGuideTitle')}
              </h3>
              <ol className="mt-4 space-y-3 text-xs text-text-secondary">
                {(['waitStep1', 'waitStep2', 'waitStep3'] as const).map((key, index) => (
                  <li key={key} className="flex items-start gap-2.5">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-soft-strong text-[11px] font-bold text-primary-strong">
                      {index + 1}
                    </span>
                    <span>{t(`vneid.register.${key}`)}</span>
                  </li>
                ))}
              </ol>
              <Notice tone="info" className="mt-5">
                <p className="font-semibold text-text-main">{t('vneidPage.phoneSafeTitle')}</p>
                <p className="mt-1 text-text-muted">{t('vneidPage.phoneSafeBody')}</p>
              </Notice>
            </div>
          </div>
        )}
      </main>

      {/* One short line, so each step fits one screen. */}
      <Footer compact />
    </div>
  );
}
export default VneidCertificateCenterPage;
