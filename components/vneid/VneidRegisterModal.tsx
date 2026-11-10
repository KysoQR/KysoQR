'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { InlineSpinner } from '@/components/signing/Spinners';
import { useRegistrationForm } from '@/lib/vneid/client/useRegistrationForm';
import {
  fetchVneidProviders,
  startVneidRegistration,
  type VneidLanguage,
  type VneidProvider,
  type VneidRegistration,
  type VneidServicePack,
} from '@/lib/vneid/client/vneidApi';
import { NoCertificateNotice } from './NoCertificateNotice';
import { PackPicker } from './PackPicker';
import { ProviderGrid } from './ProviderGrid';
import { RegistrationFormFields } from './RegistrationFormFields';
import { SelectedPackBanner } from './SelectedPackBanner';
import { buttonClass, Notice } from './ui';
import { VneidModal } from './VneidModal';

type Step = 'intro' | 'provider' | 'pack' | 'form';
const STEP_NUMBER: Record<Exclude<Step, 'intro'>, number> = { provider: 1, pack: 2, form: 3 };

/**
 * "You have no certificate": offers to register one, then provider -> pack ->
 * form -> send, with the same provider grid, pack picker and form as the
 * VNeID page (/vneid). The form is checked here with the same rules the
 * server uses (lib/vneid/registrationForm.ts) and kept in memory only:
 * nothing of it is stored in the browser or on the server, and after a reload
 * it is gone -- the registration itself is not (the server keeps its status
 * per CCCD). With `skipIntro` (the CCCD may already have certificates) it
 * opens straight on the provider step.
 */
export function VneidRegisterModal({
  citizenPid,
  language,
  skipIntro = false,
  hasCertificates = false,
  onClose,
  onRegistered,
}: {
  citizenPid: string;
  language: VneidLanguage;
  skipIntro?: boolean;
  /** The CCCD already has certificates: the intro says "register another". */
  hasCertificates?: boolean;
  onClose: () => void;
  onRegistered: (registration: VneidRegistration) => void;
}) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(skipIntro ? 'provider' : 'intro');
  const [providers, setProviders] = useState<VneidProvider[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState<VneidProvider | null>(null);
  const [pack, setPack] = useState<VneidServicePack | null>(null);
  const registrationForm = useRegistrationForm();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const loadProviders = useCallback(async () => {
    setLoadError(null);
    setProviders(null);
    try {
      setProviders(await fetchVneidProviders(language));
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [language]);

  // Opened on the provider step: load the providers, as goToProviders does.
  useEffect(() => {
    if (!skipIntro) return;
    let current = true;
    fetchVneidProviders(language).then(
      (list) => {
        if (current) setProviders(list);
      },
      (caught: unknown) => {
        if (current) setLoadError(caught instanceof Error ? caught.message : String(caught));
      }
    );
    return () => {
      current = false;
    };
  }, [skipIntro, language]);

  const goToProviders = () => {
    setStep('provider');
    if (providers === null) void loadProviders();
  };

  const close = () => {
    if (!submitting) onClose();
  };

  const submit = async () => {
    if (!provider || !pack || !registrationForm.validate()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const registration = await startVneidRegistration({
        citizenPid,
        provider: provider.provider,
        servicePackCode: pack.code,
        // Tells apart packs that share a code; the server only takes a listed name.
        servicePackName: pack.name,
        userInfo: registrationForm.userInfo(),
        language,
      });
      onRegistered(registration);
    } catch (caught) {
      setSubmitError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const footer = (
    back: () => void,
    next: { label: string; onClick: () => void; disabled?: boolean; busy?: boolean }
  ) => (
    <>
      <button
        type="button"
        onClick={back}
        disabled={submitting}
        className={buttonClass('ghost', 'sm')}
      >
        {t('vneid.register.back')}
      </button>
      <button
        type="button"
        onClick={next.onClick}
        disabled={next.disabled}
        className={buttonClass('primary')}
      >
        {next.busy && <InlineSpinner />}
        {next.label}
      </button>
    </>
  );

  if (step === 'intro') {
    return (
      <VneidModal
        title={t(
          hasCertificates ? 'vneid.register.titles.introMore' : 'vneid.register.titles.intro'
        )}
        onClose={close}
      >
        <div>
          {hasCertificates ? (
            <Notice tone="info">{t('vneid.register.introTextMore')}</Notice>
          ) : (
            <NoCertificateNotice text={t('vneid.register.introText')} />
          )}
          <ol className="mt-4 list-decimal space-y-1 pl-5 text-xs text-text-secondary">
            <li>{t('vneid.register.introStep1')}</li>
            <li>{t('vneid.register.introStep2')}</li>
            <li>{t('vneid.register.introStep3')}</li>
          </ol>
          <div className="mt-5 flex flex-col gap-2">
            <button type="button" onClick={goToProviders} className={buttonClass('primary')}>
              {t('vneid.register.openButton')}
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded-full px-5 py-2 text-sm font-medium text-text-muted hover:text-text-main"
            >
              {t('vneid.register.later')}
            </button>
          </div>
        </div>
      </VneidModal>
    );
  }

  const stepFooter =
    step === 'provider'
      ? footer(() => (skipIntro ? close() : setStep('intro')), {
          label: t('vneid.register.next'),
          onClick: () => setStep('pack'),
          disabled: !provider,
        })
      : step === 'pack'
        ? footer(() => setStep('provider'), {
            label: t('vneid.register.next'),
            onClick: () => setStep('form'),
            disabled: !pack,
          })
        : footer(() => setStep('pack'), {
            label: submitting ? t('vneid.register.submitting') : t('vneid.register.submit'),
            onClick: () => void submit(),
            disabled: !registrationForm.consent || submitting,
            busy: submitting,
          });

  return (
    <VneidModal
      size="xl"
      eyebrow={t('vneid.register.stepOf', { step: STEP_NUMBER[step] })}
      title={t(`vneid.register.titles.${step}`)}
      onClose={close}
      closeDisabled={submitting}
      footer={stepFooter}
    >
      {step === 'provider' && (
        <>
          {providers === null && !loadError && (
            <p className="flex items-center gap-2 py-4 text-xs text-text-muted">
              <InlineSpinner />
              {t('vneid.register.loadingProviders')}
            </p>
          )}
          {loadError && (
            <Notice tone="error">
              {loadError}{' '}
              <button
                type="button"
                onClick={() => void loadProviders()}
                className="font-semibold underline"
              >
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
              selected={provider}
              onSelect={(item) => {
                // Picking a provider shows its packs, as on the VNeID page.
                if (item !== provider) setPack(null);
                setProvider(item);
                setStep('pack');
              }}
              columns="sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
            />
          )}
        </>
      )}

      {step === 'pack' && provider && (
        <>
          <SelectedPackBanner
            provider={provider}
            pack={null}
            language={language}
            onChange={() => setStep('provider')}
            changeLabel={t('vneidPage.changeProvider')}
          />
          <div className="mt-4">
            <PackPicker
              provider={provider}
              selected={pack}
              onSelect={setPack}
              language={language}
              columns="sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
              heading={<p className="text-xs text-text-muted">{t('vneidPage.packSubheading')}</p>}
            />
          </div>
        </>
      )}

      {step === 'form' && provider && pack && (
        <>
          <SelectedPackBanner
            provider={provider}
            pack={pack}
            language={language}
            onChange={() => setStep('pack')}
            changeLabel={t('vneidPage.changePack')}
            disabled={submitting}
          />
          <p className="mb-3 mt-3 text-xs text-text-muted">{t('vneid.register.formHint')}</p>
          <RegistrationFormFields
            state={registrationForm}
            idPrefix="vneid-register"
            citizenPid={{ value: citizenPid }}
            disabled={submitting}
          />
          {submitError && (
            <Notice tone="error" className="mt-3">
              {submitError}
            </Notice>
          )}
        </>
      )}
    </VneidModal>
  );
}
