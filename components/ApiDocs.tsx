'use client';

import '@/lib/i18n/init';
import '@scalar/api-reference-react/style.css';
import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Header from './Header';
import { InlineSpinner } from './signing/Spinners';

/** Scalar renders its own (Vue) app that touches `window` on load, so it is
 * loaded client-side only. */
const ApiReferenceReact = dynamic(
  () => import('@scalar/api-reference-react').then((mod) => mod.ApiReferenceReact),
  {
    ssr: false,
    loading: () => (
      <div className="flex justify-center py-20">
        <InlineSpinner />
      </div>
    ),
  }
);

/** Code-sample languages not worth the tab space for this API. */
const HIDDEN_CLIENT_TARGETS = [
  'c', 'clojure', 'dart', 'fsharp', 'julia', 'kotlin', 'objc',
  'ocaml', 'powershell', 'r', 'ruby', 'rust', 'swift',
] as const;

/** Maps Scalar's accent/font onto the app's own design tokens (app/globals.css).
 * `--scalar-custom-header-height` = the app Header's `h-16` (64px), so
 * Scalar's own sticky sidebar sits below our sticky header instead of under it. */
const SCALAR_CSS = `
  .light-mode {
    --scalar-color-accent: #00a85e;
    --scalar-font: 'Be Vietnam Pro', sans-serif;
  }
  :root {
    --scalar-custom-header-height: 64px;
  }
`;

/**
 * `/docs` — interactive API reference rendered from `public/openapi/{vi,en}.yaml`
 * (the specs themselves are the source of truth; `lib/openapi.test.ts` keeps
 * them in sync with `app/api/**`). Follows the app's VI/EN switch; `?lang=en`
 * picks English on a direct link, since the app doesn't persist the language.
 */
export function ApiDocs() {
  const { i18n } = useTranslation();
  const lang = i18n.language?.startsWith('en') ? 'en' : 'vi';

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('lang');
    if (requested === 'en' || requested === 'vi') void i18n.changeLanguage(requested);
  }, [i18n]);

  return (
    <div className="flex min-h-screen flex-col bg-white text-text-main">
      <div className="sticky top-0 z-40">
        <Header maxWidthClassName="max-w-[1440px]" />
      </div>
      <main className="flex-1">
        <ApiReferenceReact
          // Remount on language change so Scalar loads the other spec file.
          key={lang}
          configuration={{
            url: `/openapi/${lang}.yaml`,
            layout: 'modern',
            forceDarkModeState: 'light',
            hideDarkModeToggle: true,
            withDefaultFonts: false,
            customCss: SCALAR_CSS,
            defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
            // Keep fields in the spec's own order (required first, then optional).
            orderSchemaPropertiesBy: 'preserve',
            orderRequiredPropertiesFirst: true,
            hiddenClients: Object.fromEntries(HIDDEN_CLIENT_TARGETS.map((target) => [target, true])),
            // Nothing about this page is sent to Scalar's own services.
            telemetry: false,
            agent: { disabled: true },
            mcp: { disabled: true },
            showDeveloperTools: 'never',
          }}
        />
      </main>
    </div>
  );
}
