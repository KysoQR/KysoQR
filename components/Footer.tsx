'use client';

import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { CASSO_HOMEPAGE_URL } from '@/lib/branding/signingMethods';

const FEATURES = [
  ['lucide:shield-check', 'footer.title1'],
  ['lucide:zap', 'footer.title2'],
  ['lucide:check-circle', 'footer.title3'],
] as const;

/**
 * Ported verbatim from x-sign-web/src/components/Footer.tsx. `compact` puts
 * everything on one short line, for pages that should fit one screen (the
 * VNeID certificate pages).
 */
export default function Footer({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();

  const madeBy = (
    <a
      href={CASSO_HOMEPAGE_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 hover:text-primary-strong"
    >
      <span>{t('footer.madeBy')}</span>
      {/* eslint-disable-next-line @next/next/no-img-element -- small static logo image, no optimization needed */}
      <img
        src="/brand/casso-logo.svg"
        alt="Casso"
        className={compact ? 'h-3.5 w-auto' : 'h-4 w-auto'}
      />
    </a>
  );

  if (compact) {
    return (
      <footer className="border-t border-border-subtle">
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1 px-4 py-2 text-center text-[11px] text-text-secondary">
          {FEATURES.map(([icon, key]) => (
            <span key={key} className="inline-flex items-center gap-1 font-medium">
              <Icon icon={icon} className="inline-block" />
              {t(key)}
            </span>
          ))}
          <span>{t('footer.footer')}</span>
          {madeBy}
        </div>
      </footer>
    );
  }

  return (
    <footer>
      <div className="mx-auto flex max-w-4xl flex-row justify-center gap-6 px-4 py-3 text-center text-xs sm:px-6">
        {FEATURES.map(([icon, key]) => (
          <div
            key={key}
            className="flex flex-col items-center justify-center gap-1.5 text-center font-medium text-text-secondary sm:flex-row"
          >
            <Icon icon={icon} className="inline-block" />
            <p>{t(key)}</p>
          </div>
        ))}
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-t border-border-subtle px-4 py-2 text-center text-xs text-text-secondary">
        <span>{t('footer.footer')}</span>
        {madeBy}
      </div>
    </footer>
  );
}
