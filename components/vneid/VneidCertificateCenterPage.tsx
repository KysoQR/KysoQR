'use client';

import '@/lib/i18n/init';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { TextField } from '@/components/TextField';
import { InlineSpinner } from '@/components/signing/Spinners';
import { formatPrice } from '@/components/vneid/VneidRegisterModal';
import { isPlausibleCitizenPid, isRegistrationOpen } from '@/lib/vneid/client/polling';
import { useVneidRegistration } from '@/lib/vneid/client/useVneidRegistration';
import {
  fetchVneidCredentials,
  fetchVneidProviders,
  startVneidRegistration,
  VneidApiError,
  type VneidCredential,
  type VneidLanguage,
  type VneidProvider,
  type VneidServicePack,
} from '@/lib/vneid/client/vneidApi';
import {
  checkRegistrationForm,
  EMPTY_REGISTRATION_FORM,
  type FieldProblem,
  GENDERS,
  type RegistrationField,
  type RegistrationForm,
  REQUIRED_FIELDS,
} from '@/lib/vneid/registrationForm';

type WizardStep = 1 | 2 | 3;
type PackFilter = 'all' | 'free' | 'paid';

const SELECT_CLASS =
  'w-full rounded-lg border bg-white px-3 py-1.5 text-sm text-text-main shadow-sm outline-none focus:ring-2 disabled:bg-gray-50';

const LIVING_FROM_PERMANENT: [RegistrationField, RegistrationField][] = [
  ['livingPlaceAddress', 'permanentAddress'],
  ['livingPlaceVillageText', 'permanentVillageText'],
  ['livingPlaceCityText', 'permanentCityText'],
];

export function VneidCertificateCenterPage() {
  const { t, i18n } = useTranslation();
  const language: VneidLanguage = i18n.language?.startsWith('en') ? 'en' : 'vi';
  const freeLabel = t('vneid.register.free');

  // Step state
  const [step, setStep] = useState<WizardStep>(1);

  // Quick lookup state
  const [lookupPid, setLookupPid] = useState('');
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupCreds, setLookupCreds] = useState<VneidCredential[] | null>(null);
  const [lookupNoCert, setLookupNoCert] = useState(false);

  // Step 1: Providers & Packs state
  const [providers, setProviders] = useState<VneidProvider[] | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<VneidProvider | null>(null);
  const [selectedPack, setSelectedPack] = useState<VneidServicePack | null>(null);
  const [packFilter, setPackFilter] = useState<PackFilter>('all');

  // Step 2: Registration Form state
  const [formPid, setFormPid] = useState('');
  const [formPidError, setFormPidError] = useState<string | null>(null);
  const [form, setForm] = useState<RegistrationForm>(EMPTY_REGISTRATION_FORM);
  const [sameAddress, setSameAddress] = useState(false);
  const [consent, setConsent] = useState(false);
  const [problems, setProblems] = useState<Partial<Record<RegistrationField, FieldProblem>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Step 3 & Active Registration tracker
  const activeCitizenPid = step === 3 ? formPid || lookupPid : lookupPid || formPid;
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

  const loadProviders = useCallback(async () => {
    setProvidersError(null);
    setProviders(null);
    try {
      const list = await fetchVneidProviders(language);
      setProviders(list);
      if (list.length > 0) {
        const first = list[0]!;
        setSelectedProvider(first);
        setSelectedPack(first.packs[0] ?? null);
      }
    } catch (caught) {
      setProvidersError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [language]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const handleLookupPidChange = (raw: string) => {
    const digits = raw.replace(/[^0-9]/g, '').slice(0, 12);
    setLookupPid(digits);
    if (!formPid) {
      setFormPid(digits);
    }
  };

  const handleQuickLookup = async () => {
    if (lookupOpen) {
      setLookupOpen(false);
      return;
    }
    if (!isPlausibleCitizenPid(lookupPid)) {
      setLookupError(t('vneid.cccdError'));
      setLookupOpen(true);
      return;
    }
    setLookupOpen(true);
    setLookupLoading(true);
    setLookupError(null);
    setLookupNoCert(false);
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

  const setField = (field: RegistrationField, value: string) => {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (sameAddress) {
        for (const [living, permanent] of LIVING_FROM_PERMANENT) {
          next[living] = next[permanent];
        }
      }
      return next;
    });
    setProblems((current) => ({ ...current, [field]: undefined }));
  };

  const toggleSameAddress = (checked: boolean) => {
    setSameAddress(checked);
    if (checked) {
      setForm((current) => {
        const next = { ...current };
        for (const [living, permanent] of LIVING_FROM_PERMANENT) {
          next[living] = current[permanent];
        }
        return next;
      });
    }
  };

  const handleFormPidChange = (raw: string) => {
    const digits = raw.replace(/[^0-9]/g, '').slice(0, 12);
    setFormPid(digits);
    setFormPidError(null);
  };

  const handleSubmitRegistration = async () => {
    if (!selectedProvider || !selectedPack) return;
    const validPid = isPlausibleCitizenPid(formPid);
    const checked = checkRegistrationForm(form);
    if (!validPid) {
      setFormPidError(t('vneid.cccdError'));
    }
    if (!checked.ok) {
      setProblems(checked.problems);
    }
    if (!validPid || !checked.ok) return;

    setSubmitting(true);
    setSubmitError(null);
    try {
      const started = await startVneidRegistration({
        citizenPid: formPid,
        provider: selectedProvider.provider,
        servicePackCode: selectedPack.code,
        servicePackName: selectedPack.name,
        userInfo: Object.fromEntries(Object.entries(form).filter(([, value]) => value.trim())),
        language,
      });
      setLookupPid(formPid);
      trackRegistration(started);
      setStep(3);
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const problemText = (name: RegistrationField) => {
    const problem = problems[name];
    return problem ? t(`vneid.register.problem.${problem}`) : null;
  };

  const renderField = (
    name: RegistrationField,
    extra: {
      type?: string;
      maxLength?: number;
      disabled?: boolean;
      autoComplete?: string;
      placeholder?: string;
    } = {}
  ) => (
    <TextField
      id={`vneid-page-${name}`}
      label={t(`vneid.register.fields.${name}`)}
      value={form[name]}
      onChange={(value) => setField(name, value)}
      error={problemText(name)}
      required={REQUIRED_FIELDS.has(name)}
      disabled={submitting || extra.disabled}
      type={extra.type ?? 'text'}
      maxLength={extra.maxLength}
      autoComplete={extra.autoComplete ?? 'off'}
      placeholder={extra.placeholder}
    />
  );

  const formatDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(language === 'en' ? 'en-GB' : 'vi-VN') : '?';

  const filteredPacks =
    selectedProvider?.packs.filter((p) => {
      if (packFilter === 'free') return p.free;
      if (packFilter === 'paid') return !p.free;
      return true;
    }) ?? [];

  const registrationOpen = registration !== null && isRegistrationOpen(registration.status);

  return (
    <div className="flex min-h-screen flex-col bg-[#f8faf9] text-text-main">
      <Header />

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6">
        {/* Top Hero + Quick Lookup Bar */}
        <div className="mb-6 rounded-2xl border border-border-subtle bg-white p-5 shadow-xs">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="inline-flex items-center gap-1.5 rounded-full bg-surface-soft px-2.5 py-0.5 text-[11px] font-semibold text-primary-strong">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                {t('vneidPage.badge')}
              </div>
              <h1 className="mt-1.5 text-xl font-bold tracking-tight text-text-main sm:text-2xl">
                {t('vneidPage.title')}
              </h1>
              <p className="mt-0.5 text-xs text-text-secondary sm:text-sm">
                {t('vneidPage.subtitle')}
              </p>
            </div>

            {/* Quick CCCD Lookup */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={12}
                  value={lookupPid}
                  onChange={(e) => handleLookupPidChange(e.target.value)}
                  placeholder={t('vneidPage.lookupPlaceholder')}
                  className="w-full rounded-xl border border-border-subtle bg-surface-soft/50 px-3.5 py-2 font-mono text-xs text-text-main outline-none focus:border-primary focus:bg-white focus:ring-2 focus:ring-primary/20 sm:w-52"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleQuickLookup()}
                disabled={lookupLoading}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-primary bg-white px-4 py-2 text-xs font-semibold text-primary shadow-2xs transition hover:bg-surface-soft disabled:opacity-60"
              >
                {lookupLoading ? (
                  <InlineSpinner />
                ) : (
                  <Icon icon="lucide:search" className="h-3.5 w-3.5" />
                )}
                <span>
                  {lookupOpen ? t('vneidPage.lookupHideButton') : t('vneidPage.lookupButton')}
                </span>
              </button>
            </div>
          </div>

          {/* Collapsible Lookup Result */}
          {lookupOpen && (
            <div className="mt-4 border-t border-border-subtle pt-4">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-text-main">
                  {t('vneidPage.lookupResultTitle')}{' '}
                  <span className="font-mono text-primary-strong">{lookupPid || '—'}</span>
                </p>
                {lookupCreds && (
                  <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-800">
                    {t('vneidPage.lookupCount', { count: lookupCreds.length })}
                  </span>
                )}
              </div>

              {lookupLoading && (
                <p className="mt-3 flex items-center gap-2 text-xs text-text-muted">
                  <InlineSpinner />
                  {t('vneid.fetchingCredentials')}
                </p>
              )}

              {lookupError && (
                <div className="mt-3 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-xs text-error-text">
                  {lookupError}
                </div>
              )}

              {!lookupLoading && lookupNoCert && (
                <p className="mt-2 text-xs text-text-muted">{t('vneidPage.lookupNoCert')}</p>
              )}

              {!lookupLoading && lookupCreds && lookupCreds.length > 0 && (
                <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2">
                  {lookupCreds.map((cred) => (
                    <div
                      key={cred.credentialId}
                      className={`flex items-start justify-between rounded-xl border p-3 ${
                        cred.usable
                          ? 'border-primary/40 bg-surface-soft/60'
                          : 'border-border-subtle bg-gray-50/70'
                      }`}
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-bold text-text-main">
                            {t('vneid.issuedBy', { issuer: cred.issuer ?? '?' })}
                          </span>
                          {cred.usable ? (
                            <span className="rounded-full bg-green-100 px-1.5 py-0.2 text-[10px] font-semibold text-green-800">
                              {t('vneidPage.activeBadge')}
                            </span>
                          ) : cred.reason ? (
                            <span className="rounded-full bg-red-100 px-1.5 py-0.2 text-[10px] font-semibold text-red-700">
                              {t(`vneid.unusable.${cred.reason}`)}
                            </span>
                          ) : null}
                        </div>
                        <p className="text-[11px] text-text-muted">
                          {t('vneid.validity', {
                            from: formatDate(cred.validFrom),
                            to: formatDate(cred.validTo),
                          })}
                          {cred.keyBits ? ` · ${t('vneid.keyBits', { bits: cred.keyBits })}` : ''}
                        </p>
                        <p className="truncate font-mono text-[10px] text-text-muted">
                          {cred.credentialId}
                        </p>
                      </div>
                      {cred.usable && (
                        <Link
                          href="/"
                          className="shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-2xs hover:bg-primary-strong"
                        >
                          {t('vneidPage.signNow')}
                        </Link>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {registration && (
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50/70 p-3">
                  <div className="flex items-center gap-2.5">
                    {registrationOpen ? (
                      <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-amber-500" />
                    ) : (
                      <Icon icon="lucide:info" className="h-4 w-4 text-amber-700" />
                    )}
                    <div>
                      <p className="text-xs font-semibold text-amber-900">
                        {t('vneidPage.lookupActiveReg')} ({registration.providerName} ·{' '}
                        {registration.servicePackName})
                      </p>
                      <p className="text-[11px] text-amber-800">
                        {t(`vneid.register.status.${registration.status}`)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setStep(3)}
                    className="rounded-lg border border-amber-400 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-900 hover:bg-amber-50"
                  >
                    {t('vneidPage.lookupViewReg')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 3-Step Horizontal Stepper */}
        <div className="mb-6 flex items-center justify-between rounded-2xl border border-border-subtle bg-white px-4 py-3.5 shadow-2xs sm:px-8">
          <button
            type="button"
            onClick={() => setStep(1)}
            className="flex items-center gap-2.5 text-left"
          >
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition ${
                step === 1
                  ? 'bg-primary text-white ring-4 ring-primary/15'
                  : step > 1
                    ? 'bg-surface-soft text-primary-strong'
                    : 'bg-gray-100 text-text-muted'
              }`}
            >
              {step > 1 ? '✓' : '1'}
            </span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                {t('vneid.register.stepOf', { step: 1 })}
              </p>
              <p
                className={`text-xs font-bold sm:text-sm ${
                  step === 1 ? 'text-text-main' : 'text-text-secondary'
                }`}
              >
                {t('vneidPage.step1Title')}
              </p>
            </div>
          </button>

          <div className="mx-2 h-px flex-1 bg-border-subtle sm:mx-4" />

          <button
            type="button"
            onClick={() => {
              if (selectedProvider && selectedPack) setStep(2);
            }}
            disabled={!selectedProvider || !selectedPack}
            className="flex items-center gap-2.5 text-left disabled:cursor-not-allowed"
          >
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition ${
                step === 2
                  ? 'bg-primary text-white ring-4 ring-primary/15'
                  : step > 2
                    ? 'bg-surface-soft text-primary-strong'
                    : 'bg-gray-100 text-text-muted'
              }`}
            >
              {step > 2 ? '✓' : '2'}
            </span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                {t('vneid.register.stepOf', { step: 2 })}
              </p>
              <p
                className={`text-xs font-bold sm:text-sm ${
                  step === 2 ? 'text-text-main' : 'text-text-secondary'
                }`}
              >
                {t('vneidPage.step2Title')}
              </p>
            </div>
          </button>

          <div className="mx-2 h-px flex-1 bg-border-subtle sm:mx-4" />

          <button
            type="button"
            onClick={() => {
              if (registration) setStep(3);
            }}
            disabled={!registration}
            className="flex items-center gap-2.5 text-left disabled:cursor-not-allowed"
          >
            <span
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition ${
                step === 3
                  ? 'bg-primary text-white ring-4 ring-primary/15'
                  : 'bg-gray-100 text-text-muted'
              }`}
            >
              3
            </span>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                {t('vneid.register.stepOf', { step: 3 })}
              </p>
              <p
                className={`text-xs font-bold sm:text-sm ${
                  step === 3 ? 'text-text-main' : 'text-text-secondary'
                }`}
              >
                {t('vneidPage.step3Title')}
              </p>
            </div>
          </button>
        </div>

        {/* STEP 1: Select CA & Package */}
        {step === 1 && (
          <div className="space-y-6">
            <div className="rounded-2xl border border-border-subtle bg-white p-5 shadow-2xs">
              <div className="mb-3.5 flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-text-main">
                    {t('vneidPage.providerHeading')}
                  </h2>
                  <p className="text-xs text-text-muted">{t('vneidPage.providerSubheading')}</p>
                </div>
              </div>

              {providers === null && !providersError && (
                <p className="flex items-center gap-2 py-4 text-xs text-text-muted">
                  <InlineSpinner />
                  {t('vneid.register.loadingProviders')}
                </p>
              )}

              {providersError && (
                <div className="rounded-xl border border-error-border bg-error-bg px-3.5 py-2.5 text-xs text-error-text">
                  {providersError}{' '}
                  <button
                    type="button"
                    onClick={() => void loadProviders()}
                    className="font-semibold underline"
                  >
                    {t('common.retry')}
                  </button>
                </div>
              )}

              {providers?.length === 0 && (
                <p className="py-4 text-xs text-text-muted">{t('vneid.register.noProviders')}</p>
              )}

              {providers && providers.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {providers.map((item, idx) => {
                    const active = selectedProvider === item;
                    const hasFree = item.packs.some((p) => p.free);
                    return (
                      <button
                        key={`${item.provider}-${idx}`}
                        type="button"
                        onClick={() => {
                          setSelectedProvider(item);
                          setSelectedPack(item.packs[0] ?? null);
                        }}
                        className={`flex flex-col justify-between rounded-xl border p-3.5 text-left transition ${
                          active
                            ? 'border-primary bg-surface-soft ring-2 ring-primary/15'
                            : 'border-border-subtle bg-white hover:border-primary/50'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-xs font-extrabold text-primary-strong">
                            {item.provider.slice(0, 3).toUpperCase()}
                          </span>
                          <span
                            className={`flex h-4 w-4 items-center justify-center rounded-full border ${
                              active ? 'border-primary bg-primary text-white' : 'border-gray-300'
                            }`}
                          >
                            {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                          </span>
                        </div>
                        <div className="mt-3">
                          <p className="text-sm font-bold text-text-main">{item.name}</p>
                          <p className="mt-0.5 text-[11px] text-text-muted">{item.provider}</p>
                        </div>
                        <div className="mt-3 flex items-center justify-between border-t border-border-subtle/80 pt-2 text-[11px]">
                          <span className="font-semibold text-primary-strong">
                            {t('vneid.register.packCount', { count: item.packs.length })}
                          </span>
                          {hasFree && (
                            <span className="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-800">
                              {t('vneidPage.hasFreeBadge')}
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Pack List */}
            {selectedProvider && (
              <div className="rounded-2xl border border-border-subtle bg-white p-5 shadow-2xs">
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-sm font-bold text-text-main">
                      {t('vneidPage.packHeading', { provider: selectedProvider.name })}
                    </h2>
                    <p className="text-xs text-text-muted">{t('vneidPage.packSubheading')}</p>
                  </div>

                  {/* Filter pills */}
                  <div className="inline-flex rounded-xl border border-border-subtle bg-[#f8faf9] p-1 text-xs">
                    {(['all', 'free', 'paid'] as const).map((filterKey) => {
                      const active = packFilter === filterKey;
                      const label =
                        filterKey === 'all'
                          ? t('vneidPage.filterAll')
                          : filterKey === 'free'
                            ? t('vneidPage.filterFree')
                            : t('vneidPage.filterPaid');
                      return (
                        <button
                          key={filterKey}
                          type="button"
                          onClick={() => setPackFilter(filterKey)}
                          className={`rounded-lg px-3 py-1 font-medium transition ${
                            active
                              ? 'bg-white font-semibold text-primary-strong shadow-2xs'
                              : 'text-text-secondary hover:text-text-main'
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {filteredPacks.length === 0 ? (
                  <p className="py-4 text-xs text-text-muted">{t('vneid.register.noPacks')}</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {filteredPacks.map((item, idx) => {
                      const active = selectedPack === item;
                      return (
                        <button
                          key={`${item.code}-${idx}`}
                          type="button"
                          onClick={() => setSelectedPack(item)}
                          className={`flex flex-col justify-between rounded-xl border p-4 text-left transition ${
                            active
                              ? 'border-primary bg-surface-soft ring-2 ring-primary/15'
                              : 'border-border-subtle bg-white hover:border-primary/50'
                          }`}
                        >
                          <div>
                            <div className="flex items-start justify-between gap-2">
                              <span
                                className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                                  item.free
                                    ? 'bg-green-100 text-green-800'
                                    : 'bg-amber-100 text-amber-900'
                                }`}
                              >
                                {formatPrice(item, language, freeLabel)}
                              </span>
                              <span className="font-mono text-[11px] text-text-muted">
                                #{item.code}
                              </span>
                            </div>
                            <p className="mt-2.5 text-sm font-bold text-text-main">{item.name}</p>
                          </div>

                          <div className="mt-4 flex items-center justify-between border-t border-border-subtle/80 pt-2.5 text-xs">
                            <span className="font-medium text-text-secondary">
                              {item.months !== null
                                ? `⏱ ${t('vneid.register.months', { count: item.months })}`
                                : '—'}
                            </span>
                            <span
                              className={`font-semibold ${
                                active ? 'text-primary-strong' : 'text-text-muted'
                              }`}
                            >
                              {active ? '✓' : '→'}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {selectedPack && !selectedPack.free && (
                  <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
                    <Icon icon="lucide:info" className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    <p>
                      {t('vneid.register.paidNote', {
                        price: formatPrice(selectedPack, language, freeLabel),
                      })}
                    </p>
                  </div>
                )}

                {/* Sticky/Bottom Action Bar */}
                <div className="mt-5 flex flex-col gap-3 border-t border-border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="text-xs text-text-secondary">
                    {selectedPack ? (
                      <>
                        {t('vneidPage.selectedSummary')}{' '}
                        <strong className="text-text-main">
                          {selectedProvider.name} · {selectedPack.name}
                        </strong>{' '}
                        <span className="font-semibold text-primary-strong">
                          ({formatPrice(selectedPack, language, freeLabel)})
                        </span>
                      </>
                    ) : (
                      <span>{t('vneid.register.titles.pack')}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={!selectedProvider || !selectedPack}
                    onClick={() => setStep(2)}
                    className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span>{t('vneidPage.continueToForm')}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* STEP 2: Registration Form */}
        {step === 2 && selectedProvider && selectedPack && (
          <div className="rounded-2xl border border-border-subtle bg-white p-5 shadow-2xs sm:p-6">
            {/* Selected Package Summary Banner */}
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-surface-soft px-4 py-3">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-xs font-bold text-white">
                  CA
                </span>
                <div>
                  <p className="text-xs font-bold text-text-main">
                    {selectedProvider.name} · {selectedPack.name}
                  </p>
                  <p className="text-[11px] text-text-secondary">
                    #{selectedPack.code}
                    {selectedPack.months !== null
                      ? ` · ${t('vneid.register.months', { count: selectedPack.months })}`
                      : ''}{' '}
                    ·{' '}
                    <span className="font-semibold text-primary-strong">
                      {formatPrice(selectedPack, language, freeLabel)}
                    </span>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="text-xs font-semibold text-primary hover:underline"
              >
                {t('vneidPage.changePack')}
              </button>
            </div>

            <p className="mb-4 text-xs text-text-muted">{t('vneid.register.formHint')}</p>

            {/* Section I: Identity & Contact */}
            <fieldset>
              <legend className="mb-3 text-xs font-bold uppercase tracking-wider text-primary-strong">
                {t('vneidPage.sectionIdentity')}
              </legend>
              <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
                <TextField
                  id="vneid-page-citizenPid"
                  label={t('vneid.register.fields.citizenPid')}
                  value={formPid}
                  onChange={handleFormPidChange}
                  error={formPidError}
                  required
                  inputMode="numeric"
                  maxLength={12}
                  placeholder="001099012345"
                  disabled={submitting}
                />
                {renderField('fullName', {
                  autoComplete: 'name',
                  placeholder: 'NGUYỄN VĂN A',
                })}
                {renderField('birthDate', { type: 'date' })}

                <div className="space-y-1">
                  <label
                    htmlFor="vneid-page-gender"
                    className="block text-xs font-medium text-text-main"
                  >
                    {t('vneid.register.fields.gender')}
                    <span className="ml-0.5 text-error-text">*</span>
                  </label>
                  <select
                    id="vneid-page-gender"
                    value={form.gender}
                    onChange={(event) => setField('gender', event.target.value)}
                    disabled={submitting}
                    aria-invalid={problems.gender ? true : undefined}
                    className={`${SELECT_CLASS} ${
                      problems.gender
                        ? 'border-error-border focus:border-error-text focus:ring-error-text/30'
                        : 'border-border-subtle focus:border-primary focus:ring-primary/30'
                    }`}
                  >
                    <option value="">{t('vneid.register.selectGender')}</option>
                    <option value={GENDERS[0]}>{t('vneid.register.genders.male')}</option>
                    <option value={GENDERS[1]}>{t('vneid.register.genders.female')}</option>
                  </select>
                  {problems.gender && (
                    <p className="mt-0.5 text-[11px] text-error-text">{problemText('gender')}</p>
                  )}
                </div>

                {renderField('phone', {
                  type: 'tel',
                  autoComplete: 'tel',
                  placeholder: '0901234567',
                })}
                {renderField('email', {
                  type: 'email',
                  autoComplete: 'email',
                  placeholder: 'name@example.com',
                })}
                {renderField('nationalityCode', { maxLength: 2, placeholder: 'VN' })}
                {renderField('issuingAuthority')}
                {renderField('dateOfIssue', { type: 'date' })}
                {renderField('idCardExpireDate', { type: 'date' })}
              </div>
            </fieldset>

            {/* Section II: Permanent Address */}
            <fieldset className="mt-6 border-t border-border-subtle pt-5">
              <legend className="mb-3 text-xs font-bold uppercase tracking-wider text-primary-strong">
                {t('vneidPage.sectionPermanent')}
              </legend>
              <div className="grid gap-3.5 sm:grid-cols-2">
                <div className="sm:col-span-2">{renderField('permanentAddress')}</div>
                {renderField('permanentVillageText')}
                {renderField('permanentCityText')}
              </div>
            </fieldset>

            {/* Section III: Living Address */}
            <fieldset className="mt-6 border-t border-border-subtle pt-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <legend className="text-xs font-bold uppercase tracking-wider text-primary-strong">
                  {t('vneidPage.sectionLiving')}
                </legend>
                <label className="flex items-center gap-2 text-xs font-medium text-text-secondary">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={sameAddress}
                    disabled={submitting}
                    onChange={(event) => toggleSameAddress(event.target.checked)}
                  />
                  <span>{t('vneid.register.sameAddress')}</span>
                </label>
              </div>
              <div className="grid gap-3.5 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  {renderField('livingPlaceAddress', { disabled: sameAddress })}
                </div>
                {renderField('livingPlaceVillageText', { disabled: sameAddress })}
                {renderField('livingPlaceCityText', { disabled: sameAddress })}
              </div>
            </fieldset>

            {/* Consent */}
            <label className="mt-6 flex items-start gap-2.5 rounded-xl border border-border-subtle bg-[#f8faf9] p-3.5 text-xs text-text-secondary">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                checked={consent}
                disabled={submitting}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>{t('vneid.register.consent')}</span>
            </label>

            {(Object.values(problems).some(Boolean) || formPidError) && (
              <p className="mt-3 text-xs font-medium text-error-text">
                {t('vneid.register.fixProblems')}
              </p>
            )}

            {submitError && (
              <div className="mt-3 rounded-xl border border-error-border bg-error-bg px-3.5 py-2.5 text-xs text-error-text">
                {submitError}
              </div>
            )}

            {/* Footer buttons */}
            <div className="mt-6 flex items-center justify-between border-t border-border-subtle pt-4">
              <button
                type="button"
                onClick={() => setStep(1)}
                disabled={submitting}
                className="rounded-full border border-border-subtle bg-white px-4 py-2 text-xs font-semibold text-text-secondary hover:bg-gray-50 disabled:opacity-60"
              >
                {t('vneidPage.backToPacks')}
              </button>
              <button
                type="button"
                onClick={() => void handleSubmitRegistration()}
                disabled={!consent || submitting}
                className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting && <InlineSpinner />}
                <span>
                  {submitting ? t('vneid.register.submitting') : t('vneidPage.submitToVneid')}
                </span>
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: Activate on VNeID */}
        {step === 3 && (
          <div className="grid gap-5 lg:grid-cols-12">
            {/* Left 7 cols: Live Tracker */}
            <div className="rounded-2xl border border-border-subtle bg-white p-5 shadow-2xs lg:col-span-7">
              {registration ? (
                <>
                  <div className="flex items-start justify-between gap-3 border-b border-border-subtle pb-4">
                    <div>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                          registration.status === 'COMPLETED'
                            ? 'bg-green-100 text-green-800'
                            : registrationOpen
                              ? 'bg-amber-100 text-amber-900'
                              : 'bg-red-100 text-red-700'
                        }`}
                      >
                        {registrationOpen && (
                          <span className="h-1.5 w-1.5 animate-ping rounded-full bg-amber-600" />
                        )}
                        {registration.status}
                      </span>
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
                  </div>

                  {/* 3-stage visual timeline */}
                  <div className="mt-5 space-y-4">
                    {/* Stage 1: PENDING */}
                    <div
                      className={`flex items-start gap-3 rounded-xl border p-3.5 ${
                        registration.status === 'PENDING'
                          ? 'border-primary bg-surface-soft'
                          : 'border-border-subtle bg-white'
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                          registration.status === 'PENDING'
                            ? 'bg-primary text-white'
                            : registration.status === 'ISSUED' ||
                                registration.status === 'COMPLETED'
                              ? 'bg-green-600 text-white'
                              : 'bg-gray-200 text-text-muted'
                        }`}
                      >
                        {registration.status === 'ISSUED' || registration.status === 'COMPLETED'
                          ? '✓'
                          : '1'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-text-main">
                          {t('vneid.register.status.PENDING')}
                        </p>
                        <p className="mt-0.5 text-xs text-text-secondary">
                          {t('vneid.register.waitStep2')}
                        </p>
                      </div>
                    </div>

                    {/* Stage 2: ISSUED */}
                    <div
                      className={`flex items-start gap-3 rounded-xl border p-3.5 ${
                        registration.status === 'ISSUED'
                          ? 'border-primary bg-surface-soft'
                          : 'border-border-subtle bg-white'
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                          registration.status === 'ISSUED'
                            ? 'bg-primary text-white'
                            : registration.status === 'COMPLETED'
                              ? 'bg-green-600 text-white'
                              : 'bg-gray-200 text-text-muted'
                        }`}
                      >
                        {registration.status === 'COMPLETED' ? '✓' : '2'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-text-main">
                          {t('vneid.register.status.ISSUED')}
                        </p>
                        <p className="mt-0.5 text-xs text-text-secondary">
                          {t('vneid.register.waitStep3')}
                        </p>
                      </div>
                    </div>

                    {/* Stage 3: COMPLETED */}
                    <div
                      className={`flex items-start gap-3 rounded-xl border p-3.5 ${
                        registration.status === 'COMPLETED'
                          ? 'border-green-500 bg-green-50'
                          : 'border-border-subtle bg-white'
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                          registration.status === 'COMPLETED'
                            ? 'bg-green-600 text-white'
                            : 'bg-gray-200 text-text-muted'
                        }`}
                      >
                        {registration.status === 'COMPLETED' ? '✓' : '3'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-bold text-text-main">
                          {t('vneid.register.status.COMPLETED')}
                        </p>
                        {registration.serialNumber && (
                          <p className="mt-1 truncate font-mono text-[11px] text-green-800">
                            Serial: {registration.serialNumber}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Error / Terminal failure reason */}
                  {!registrationOpen && registration.status !== 'COMPLETED' && (
                    <div className="mt-4 rounded-xl border border-error-border bg-error-bg p-3.5 text-xs text-error-text">
                      <p className="font-bold">
                        {t(`vneid.register.status.${registration.status}`)}
                      </p>
                      {registration.reason && (
                        <p className="mt-0.5">
                          {t(`vneid.register.reason.${registration.reason}`)}
                        </p>
                      )}
                    </div>
                  )}

                  {pollError && <p className="mt-3 text-xs text-error-text">{pollError}</p>}

                  <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
                    <button
                      type="button"
                      onClick={() => {
                        clearRegistration();
                        setStep(1);
                      }}
                      className="rounded-full border border-border-subtle bg-white px-4 py-2 text-xs font-semibold text-text-secondary hover:bg-gray-50"
                    >
                      {t('vneidPage.registerAnother')}
                    </button>

                    {registration.status === 'COMPLETED' && (
                      <Link
                        href="/"
                        className="inline-flex items-center gap-1.5 rounded-full bg-primary px-5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-primary-strong"
                      >
                        <span>{t('vneidPage.signNow')}</span>
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
                    className="mt-4 rounded-full bg-primary px-5 py-2 text-xs font-semibold text-white"
                  >
                    {t('vneid.register.openButton')}
                  </button>
                </div>
              )}
            </div>

            {/* Right 5 cols: Phone Instructions */}
            <div className="rounded-2xl border border-border-subtle bg-white p-5 shadow-2xs lg:col-span-5">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-surface-soft px-2.5 py-0.5 text-[11px] font-semibold text-primary-strong">
                <Icon icon="lucide:smartphone" className="h-3.5 w-3.5" />
                {t('vneidPage.phoneGuideBadge')}
              </div>
              <h3 className="mt-2 text-sm font-bold text-text-main">
                {t('vneidPage.phoneGuideTitle')}
              </h3>

              <ol className="mt-4 space-y-3 text-xs text-text-secondary">
                <li className="flex items-start gap-2.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-soft text-[11px] font-bold text-primary-strong">
                    1
                  </span>
                  <span>{t('vneid.register.waitStep1')}</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-soft text-[11px] font-bold text-primary-strong">
                    2
                  </span>
                  <span>{t('vneid.register.waitStep2')}</span>
                </li>
                <li className="flex items-start gap-2.5">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-soft text-[11px] font-bold text-primary-strong">
                    3
                  </span>
                  <span>{t('vneid.register.waitStep3')}</span>
                </li>
              </ol>

              <div className="mt-5 rounded-xl border border-border-subtle bg-[#f8faf9] p-3.5 text-xs">
                <p className="font-semibold text-text-main">{t('vneidPage.phoneSafeTitle')}</p>
                <p className="mt-1 text-text-muted">{t('vneidPage.phoneSafeBody')}</p>
              </div>
            </div>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
export default VneidCertificateCenterPage;

