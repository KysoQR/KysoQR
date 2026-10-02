'use client';

import { useTranslation } from 'react-i18next';
import { CASSO_HOMEPAGE_URL } from '@/lib/branding/signingMethods';

/** "KysoQR is a Casso product" band, shown between the methods section and the footer. */
export function CassoBrandBand() {
  const { t } = useTranslation();

  return (
    <section className="border-y border-border-subtle bg-[#F5FBF7]">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-5 px-4 py-8 sm:px-6 md:flex-row md:items-center md:justify-between md:py-10">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-5">
          {/* eslint-disable-next-line @next/next/no-img-element -- small static logo image, no optimization needed */}
          <img src="/brand/casso-logo.svg" alt="Casso" className="h-8 w-auto" />
          <div aria-hidden="true" className="hidden h-8 w-px bg-border-subtle sm:block" />
          <p className="max-w-xl text-[15px] leading-relaxed text-text-main">
            {t('home.branding.cassoTagline')}
          </p>
        </div>
        <a
          href={CASSO_HOMEPAGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-primary px-5 text-sm font-semibold text-primary-strong transition-colors hover:bg-surface-soft"
        >
          {t('home.branding.learnMore')}
        </a>
      </div>
    </section>
  );
}
