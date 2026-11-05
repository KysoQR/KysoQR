'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import { TextField } from '@/components/TextField';
import { InlineSpinner } from '@/components/signing/Spinners';
import {
  fetchVneidProviders,
  startVneidRegistration,
  type VneidLanguage,
  type VneidProvider,
  type VneidRegistration,
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

type Step = 'intro' | 'provider' | 'pack' | 'form';
const STEP_NUMBER: Record<Exclude<Step, 'intro'>, number> = { provider: 1, pack: 2, form: 3 };

const SELECT_CLASS =
  'w-full rounded-lg border bg-white px-3 py-1.5 text-sm text-text-main shadow-sm outline-none focus:ring-2 disabled:bg-gray-50';
const CARD_CLASS =
  'flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-xs transition';

const LIVING_FROM_PERMANENT: [RegistrationField, RegistrationField][] = [
  ['livingPlaceAddress', 'permanentAddress'],
  ['livingPlaceVillageText', 'permanentVillageText'],
  ['livingPlaceCityText', 'permanentCityText'],
];

export function formatPrice(pack: VneidServicePack, language: VneidLanguage, free: string) {
  if (pack.free) return free;
  if (pack.unitPrice === null) return '?';
  return new Intl.NumberFormat(language === 'en' ? 'en-US' : 'vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(pack.unitPrice);
}

/**
 * "You have no certificate": offers to register one, then provider -> pack ->
 * form -> send. The form is checked here with the same rules the server uses
 * (lib/vneid/registrationForm.ts) and kept in memory only: nothing of it is
 * stored in the browser or on the server, and after a reload it is gone --
 * the registration itself is not (the server keeps its status per CCCD).
 *
 * Rendered into document.body: the signer column it is opened from is moved
 * with a CSS transform while the page scrolls (StickyAnchorColumn), and a
 * transformed ancestor would turn this full-screen overlay into one boxed in
 * that column, under the wizard's sticky bar.
 */
export function VneidRegisterModal({
  citizenPid,
  language,
  onClose,
  onRegistered,
}: {
  citizenPid: string;
  language: VneidLanguage;
  onClose: () => void;
  onRegistered: (registration: VneidRegistration) => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('intro');
  const [providers, setProviders] = useState<VneidProvider[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState<VneidProvider | null>(null);
  const [pack, setPack] = useState<VneidServicePack | null>(null);
  const [form, setForm] = useState<RegistrationForm>(EMPTY_REGISTRATION_FORM);
  const [sameAddress, setSameAddress] = useState(false);
  const [consent, setConsent] = useState(false);
  const [problems, setProblems] = useState<Partial<Record<RegistrationField, FieldProblem>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Focus the dialog so Escape closes it without a click first.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const loadProviders = useCallback(async () => {
    setLoadError(null);
    setProviders(null);
    try {
      setProviders(await fetchVneidProviders(language));
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [language]);

  const goToProviders = () => {
    setStep('provider');
    if (providers === null) void loadProviders();
  };

  const close = useCallback(() => {
    if (!submitting) onClose();
  }, [onClose, submitting]);

  const setField = (field: RegistrationField, value: string) => {
    setForm((current) => {
      const next = { ...current, [field]: value };
      if (sameAddress) {
        for (const [living, permanent] of LIVING_FROM_PERMANENT) next[living] = next[permanent];
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
        for (const [living, permanent] of LIVING_FROM_PERMANENT) next[living] = current[permanent];
        return next;
      });
    }
  };

  const submit = async () => {
    if (!provider || !pack) return;
    const checked = checkRegistrationForm(form);
    if (!checked.ok) {
      setProblems(checked.problems);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const registration = await startVneidRegistration({
        citizenPid,
        provider: provider.provider,
        servicePackCode: pack.code,
        // Tells apart packs that share a code; the server only takes a listed name.
        servicePackName: pack.name,
        // What the person typed (dates as YYYY-MM-DD); the server checks and converts it again.
        userInfo: Object.fromEntries(Object.entries(form).filter(([, value]) => value.trim())),
        language,
      });
      onRegistered(registration);
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

  const field = (
    name: RegistrationField,
    extra: { type?: string; maxLength?: number; disabled?: boolean; autoComplete?: string } = {}
  ) => (
    <TextField
      id={`vneid-register-${name}`}
      label={t(`vneid.register.fields.${name}`)}
      value={form[name]}
      onChange={(value) => setField(name, value)}
      error={problemText(name)}
      required={REQUIRED_FIELDS.has(name)}
      disabled={submitting || extra.disabled}
      type={extra.type ?? 'text'}
      maxLength={extra.maxLength}
      autoComplete={extra.autoComplete ?? 'off'}
    />
  );

  const footer = (
    back: () => void,
    next: { label: string; onClick: () => void; disabled?: boolean; busy?: boolean }
  ) => (
    <div className="mt-5 flex items-center justify-between gap-2">
      <button
        type="button"
        onClick={back}
        disabled={submitting}
        className="rounded-full px-4 py-2 text-sm font-medium text-text-muted hover:text-text-main disabled:opacity-60"
      >
        {t('vneid.register.back')}
      </button>
      <button
        type="button"
        onClick={next.onClick}
        disabled={next.disabled}
        className="inline-flex items-center gap-1.5 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-60"
      >
        {next.busy && <InlineSpinner />}
        {next.label}
      </button>
    </div>
  );

  const choice = (active: boolean, onClick: () => void, key: string, body: ReactNode) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`${CARD_CLASS} ${
        active
          ? 'border-primary bg-surface-soft'
          : 'border-border-subtle bg-white hover:border-primary'
      }`}
    >
      <Icon
        icon={active ? 'lucide:circle-dot' : 'lucide:circle'}
        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${active ? 'text-primary' : 'text-text-muted'}`}
      />
      <span className="min-w-0 flex-1">{body}</span>
    </button>
  );

  const freeLabel = t('vneid.register.free');

  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vneid-register-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
      tabIndex={-1}
    >
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col rounded-2xl border border-border-subtle bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div>
            {step !== 'intro' && (
              <p className="text-[11px] font-medium uppercase tracking-wide text-text-muted">
                {t('vneid.register.stepOf', { step: STEP_NUMBER[step] })}
              </p>
            )}
            <h2 id="vneid-register-title" className="text-base font-semibold text-text-main">
              {t(`vneid.register.titles.${step}`)}
            </h2>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={submitting}
            aria-label={t('common.close')}
            className="rounded-full p-1 text-text-muted hover:bg-surface-soft hover:text-text-main disabled:opacity-60"
          >
            <Icon icon="lucide:x" className="h-4 w-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4">
          {step === 'intro' && (
            <div className="text-center">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface-soft text-primary">
                <Icon icon="lucide:badge-check" className="h-6 w-6" />
              </div>
              <p className="mt-3 text-sm text-text-main">{t('vneid.register.introText')}</p>
              <ol className="mt-3 list-decimal space-y-1 pl-5 text-left text-xs text-text-muted">
                <li>{t('vneid.register.introStep1')}</li>
                <li>{t('vneid.register.introStep2')}</li>
                <li>{t('vneid.register.introStep3')}</li>
              </ol>
              <div className="mt-5 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={goToProviders}
                  className="inline-flex items-center justify-center gap-1.5 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-strong"
                >
                  {t('vneid.register.openButton')}
                </button>
                <button
                  type="button"
                  onClick={close}
                  className="inline-flex items-center justify-center rounded-full px-5 py-2 text-sm font-medium text-text-muted hover:text-text-main"
                >
                  {t('vneid.register.later')}
                </button>
              </div>
            </div>
          )}

          {step === 'provider' && (
            <>
              {providers === null && !loadError && (
                <p className="flex items-center gap-2 text-xs text-text-muted">
                  <InlineSpinner />
                  {t('vneid.register.loadingProviders')}
                </p>
              )}
              {loadError && (
                <div className="rounded-md border border-error-border bg-error-bg px-3 py-2 text-xs text-error-text">
                  {loadError}{' '}
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
                <p className="text-xs text-text-muted">{t('vneid.register.noProviders')}</p>
              )}
              {providers && providers.length > 0 && (
                <div
                  role="radiogroup"
                  aria-label={t('vneid.register.titles.provider')}
                  className="space-y-1.5"
                >
                  {/* By position and identity, not code: CSign codes need not be unique. */}
                  {providers.map((item, index) =>
                    choice(
                      provider === item,
                      () => {
                        setProvider(item);
                        setPack(null);
                      },
                      `${item.provider}-${index}`,
                      <>
                        <span className="block font-semibold text-text-main">{item.name}</span>
                        <span className="block text-text-muted">
                          {item.provider} ·{' '}
                          {t('vneid.register.packCount', { count: item.packs.length })}
                        </span>
                      </>
                    )
                  )}
                </div>
              )}
              {footer(() => setStep('intro'), {
                label: t('vneid.register.next'),
                onClick: () => setStep('pack'),
                disabled: !provider,
              })}
            </>
          )}

          {step === 'pack' && provider && (
            <>
              <p className="mb-2 text-xs text-text-muted">{provider.name}</p>
              {provider.packs.length === 0 ? (
                <p className="text-xs text-text-muted">{t('vneid.register.noPacks')}</p>
              ) : (
                <div
                  role="radiogroup"
                  aria-label={t('vneid.register.titles.pack')}
                  className="space-y-1.5"
                >
                  {/* CSign lists some packs twice under one code (seen: VNPT 18130). */}
                  {provider.packs.map((item, index) =>
                    choice(
                      pack === item,
                      () => setPack(item),
                      `${item.code}-${index}`,
                      <>
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="font-semibold text-text-main">{item.name}</span>
                          <span
                            className={`shrink-0 font-semibold ${item.free ? 'text-green-700' : 'text-text-main'}`}
                          >
                            {formatPrice(item, language, freeLabel)}
                          </span>
                        </span>
                        <span className="block text-text-muted">
                          {item.months !== null &&
                            `${t('vneid.register.months', { count: item.months })} · `}
                          {item.code}
                        </span>
                      </>
                    )
                  )}
                </div>
              )}
              {pack && !pack.free && (
                <p className="mt-2 rounded-md bg-warning-bg px-3 py-2 text-[11px] text-warning-text">
                  {t('vneid.register.paidNote', { price: formatPrice(pack, language, freeLabel) })}
                </p>
              )}
              {footer(() => setStep('provider'), {
                label: t('vneid.register.next'),
                onClick: () => setStep('form'),
                disabled: !pack,
              })}
            </>
          )}

          {step === 'form' && provider && pack && (
            <>
              <p className="mb-2 rounded-md bg-surface-soft px-3 py-2 text-xs text-text-main">
                {provider.name} · {pack.name} · {formatPrice(pack, language, freeLabel)}
              </p>
              <p className="mb-3 text-[11px] text-text-muted">{t('vneid.register.formHint')}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  id="vneid-register-citizenPid"
                  label={t('vneid.register.fields.citizenPid')}
                  value={citizenPid}
                  onChange={() => undefined}
                  readOnly
                  disabled
                />
                {field('fullName', { autoComplete: 'name' })}
                {field('birthDate', { type: 'date' })}
                <div className="space-y-1">
                  <label
                    htmlFor="vneid-register-gender"
                    className="block text-xs font-medium text-text-main"
                  >
                    {t('vneid.register.fields.gender')}
                    <span className="ml-0.5 text-error-text">*</span>
                  </label>
                  <select
                    id="vneid-register-gender"
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
                {field('phone', { type: 'tel', autoComplete: 'tel' })}
                {field('email', { type: 'email', autoComplete: 'email' })}
                {field('nationalityCode', { maxLength: 2 })}
                {field('issuingAuthority')}
                {field('dateOfIssue', { type: 'date' })}
                {field('idCardExpireDate', { type: 'date' })}
              </div>

              <fieldset className="mt-4">
                <legend className="text-xs font-semibold text-text-main">
                  {t('vneid.register.permanentTitle')}
                </legend>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">{field('permanentAddress')}</div>
                  {field('permanentVillageText')}
                  {field('permanentCityText')}
                </div>
              </fieldset>

              <fieldset className="mt-4">
                <legend className="text-xs font-semibold text-text-main">
                  {t('vneid.register.livingTitle')}
                </legend>
                <label className="mt-1 flex items-center gap-2 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-primary"
                    checked={sameAddress}
                    disabled={submitting}
                    onChange={(event) => toggleSameAddress(event.target.checked)}
                  />
                  {t('vneid.register.sameAddress')}
                </label>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    {field('livingPlaceAddress', { disabled: sameAddress })}
                  </div>
                  {field('livingPlaceVillageText', { disabled: sameAddress })}
                  {field('livingPlaceCityText', { disabled: sameAddress })}
                </div>
              </fieldset>

              <label className="mt-4 flex items-start gap-2 text-xs text-text-secondary">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                  checked={consent}
                  disabled={submitting}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>{t('vneid.register.consent')}</span>
              </label>
              {Object.values(problems).some(Boolean) && (
                <p className="mt-2 text-xs text-error-text">{t('vneid.register.fixProblems')}</p>
              )}
              {submitError && (
                <div className="mt-3 rounded-md border border-error-border bg-error-bg px-3 py-2 text-xs text-error-text">
                  {submitError}
                </div>
              )}
              {footer(() => setStep('pack'), {
                label: submitting ? t('vneid.register.submitting') : t('vneid.register.submit'),
                onClick: () => void submit(),
                disabled: !consent || submitting,
                busy: submitting,
              })}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
