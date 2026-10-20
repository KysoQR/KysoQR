'use client';

import '@/lib/i18n/init';
import { useTranslation } from 'react-i18next';
import Header from './Header';
import Footer from './Footer';

/** Shell for a nav destination whose copy is not written yet. */
export function PlaceholderPage({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-screen flex-col bg-white text-text-main">
      <Header />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight text-text-main">{t(titleKey)}</h1>
        <p className="mt-3 text-text-secondary">{t('nav.comingSoon')}</p>
      </main>
      <Footer />
    </div>
  );
}
