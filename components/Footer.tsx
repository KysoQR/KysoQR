'use client';

import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { CASSO_HOMEPAGE_URL } from '@/lib/branding/signingMethods';

/** Ported verbatim from x-sign-web/src/components/Footer.tsx. */
export default function Footer() {
  const { t } = useTranslation();

  return (
    <footer>
      <div className="mx-auto flex max-w-4xl flex-row justify-center gap-6 px-4 py-3 text-center text-xs sm:px-6">
        <div className="flex flex-col items-center justify-center gap-1.5 text-center font-medium text-text-secondary sm:flex-row">
          <Icon icon="lucide:shield-check" className="inline-block" />
          <p>{t('footer.title1')}</p>
        </div>
        <div className="flex flex-col items-center justify-center gap-1.5 text-center font-medium text-text-secondary sm:flex-row">
          <Icon icon="lucide:zap" className="inline-block" />
          <p>{t('footer.title2')}</p>
        </div>
        <div className="flex flex-col items-center justify-center gap-1.5 text-center font-medium text-text-secondary sm:flex-row">
          <Icon icon="lucide:check-circle" className="inline-block" />
          <p>{t('footer.title3')}</p>
        </div>
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-border-subtle px-4 py-2 text-center text-xs text-text-secondary">
        <span>{t('footer.footer')}</span>
        <a
          href={CASSO_HOMEPAGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 hover:text-primary-strong"
        >
          <span>{t('footer.madeBy')}</span>
          {/* eslint-disable-next-line @next/next/no-img-element -- small static logo image, no optimization needed */}
          <img src="/brand/casso-logo.svg" alt="Casso" className="h-4 w-auto" />
        </a>
      </div>
    </footer>
  );
}
