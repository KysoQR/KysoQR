'use client';

import { useTranslation } from 'react-i18next';
import {
  CAS_ID_REGISTER_URL,
  SIGNING_METHODS,
  type SigningMethod,
} from '@/lib/branding/signingMethods';

/**
 * Landing-page section listing the signing methods in the Casso ecosystem
 * and, under each, the signature providers (CAs) behind it. Data lives in
 * lib/branding/signingMethods.ts; only CAS ID is usable on KysoQR today.
 */
export function SigningMethodsSection() {
  const { t } = useTranslation();

  return (
    <section aria-labelledby="signing-methods-title" className="bg-white">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-12 sm:px-6 sm:py-16">
        <div className="flex max-w-2xl flex-col gap-2.5">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-primary-strong">
            {/* eslint-disable-next-line @next/next/no-img-element -- small static logo image, no optimization needed */}
            <img src="/brand/casso-symbol.svg" alt="" className="h-5 w-5" />
            <span>{t('home.branding.eyebrow')}</span>
          </div>
          <h2
            id="signing-methods-title"
            className="text-2xl font-semibold tracking-tight text-text-main sm:text-3xl"
          >
            {t('home.branding.title')}
          </h2>
          <p className="text-[15px] leading-relaxed text-text-secondary">
            {t('home.branding.subtitle')}
          </p>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          {SIGNING_METHODS.map((method) => (
            <MethodCard key={method.key} method={method} />
          ))}
        </div>
      </div>
    </section>
  );
}

function MethodCard({ method }: { method: SigningMethod }) {
  const { t } = useTranslation();
  const base = `home.branding.methods.${method.key}`;

  return (
    <article
      className={`flex flex-col gap-4 rounded-[20px] p-6 ${
        method.available ? 'border-2 border-primary bg-white' : 'border border-gray-200 bg-gray-50'
      }`}
    >
      <div className="flex min-h-12 items-center justify-between gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element -- small static logo image, no optimization needed */}
        <img
          src={method.logo}
          alt={t(`${base}.name`)}
          className={method.key === 'casid' ? 'h-7 w-auto' : 'h-12 w-12'}
        />
        {method.available ? (
          <span className="whitespace-nowrap rounded-full bg-primary-strong px-2.5 py-1 text-xs font-semibold text-white">
            {t('home.branding.availableBadge')}
          </span>
        ) : (
          <span className="whitespace-nowrap rounded-full bg-warning-border px-2.5 py-1 text-xs font-semibold text-warning-text">
            {t('home.branding.inDevelopmentBadge')}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <h3
          className={`text-xl font-semibold ${method.available ? 'text-text-main' : 'text-gray-700'}`}
        >
          {t(`${base}.title`)}
        </h3>
        <p
          className={`text-sm leading-relaxed ${
            method.available ? 'text-text-secondary' : 'text-text-muted'
          }`}
        >
          {t(`${base}.description`)}
        </p>
      </div>

      <div className="flex flex-col gap-2.5 border-t border-gray-200 pt-3.5">
        <div className="text-xs font-semibold text-text-muted">
          {t('home.branding.providersLabel')}
        </div>
        <ul className="grid grid-cols-3 gap-2">
          {method.providers.map((provider) => (
            <li
              key={provider.name}
              className="flex h-[52px] flex-col items-center justify-center gap-0.5 rounded-[10px] border border-gray-200 bg-white px-2.5"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- small static logo image, no optimization needed */}
              <img
                src={provider.logo}
                alt={provider.name}
                className={`max-w-full object-contain ${provider.caption ? 'max-h-[18px]' : 'max-h-7'}`}
              />
              {provider.caption && (
                <span className="text-[10px] font-semibold leading-none text-text-muted">
                  {provider.caption}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {method.available && (
        <a
          href={CAS_ID_REGISTER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-auto inline-flex min-h-11 items-center self-start rounded-full bg-primary px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-strong"
        >
          {t('home.branding.registerFree')}
        </a>
      )}
    </article>
  );
}
