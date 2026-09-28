'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from './LanguageSwitcher';

/** Simplified port of x-sign-web/src/components/Header.tsx — single nav tab
 * (no separate Swagger API-docs route in this repo), `rightSlot` kept so the
 * home page's "Dùng thử miễn phí" CTA still works exactly like the original.
 * `centerContent` is a later addition: the signing wizard's step indicator
 * renders inline here (see SigningWizard.tsx) instead of as its own card
 * below the header, to reclaim vertical space. Always laid out as a 3-slot
 * row (logo / center / right) so adding this slot doesn't change the
 * logo-left, controls-right result on pages that don't pass it. */
export default function Header({
  rightSlot,
  centerContent,
  maxWidthClassName = 'max-w-6xl',
  onLogoClick,
}: {
  rightSlot?: ReactNode;
  centerContent?: ReactNode;
  /** Matches this header's inner container width to whatever the page below
   * it actually uses -- defaults to HomeLanding's `max-w-6xl`. Needed
   * because SigningWizard's own content area is wider (`max-w-[1440px]`);
   * without passing that here too, the header's content stays clumped in
   * the narrower default width while the page below (and any fixed-position
   * element anchored to the real viewport edge, like the signature-history
   * toggle) spans the full wider layout, leaving a visible dead gap between
   * them on wide screens. */
  maxWidthClassName?: string;
  /** `app/page.tsx` toggles HomeLanding/SigningWizard as a client-side view
   * switch, not a real navigation -- both live at the same `/` URL. So a
   * plain `<Link href="/">` is a no-op while already on that URL (which is
   * always true here), and clicking the logo from inside the wizard would
   * otherwise appear to do nothing. Callers showing the wizard pass their
   * own "go back to home" handler here; the home page itself has nothing to
   * do (already home), so it's optional. */
  onLogoClick?: () => void;
}) {
  const { t } = useTranslation();
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <>
      <header className="border-b border-border-subtle bg-white/95 backdrop-blur">
        <div className={`mx-auto flex h-16 items-center px-4 sm:px-6 ${maxWidthClassName}`}>
          <Link href="/" onClick={onLogoClick} className="flex shrink-0 items-center gap-0">
            {/* eslint-disable-next-line @next/next/no-img-element -- small static logo image, no optimization needed */}
            <img
              src="/kysoqr-logo.png"
              alt="KysoQR"
              className="h-9 w-auto object-contain sm:h-12"
            />
          </Link>

          {/* Always rendered (even with no centerContent, or below `lg`) so it
              keeps soaking up the remaining space between the logo and the
              right-side controls -- otherwise removing/hiding it would pull
              the controls back next to the logo instead of the far edge. */}
          <div className="flex flex-1 items-center justify-center px-2">
            {centerContent && <div className="hidden lg:flex">{centerContent}</div>}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-4 sm:gap-16">
            <nav
              className="hidden items-stretch gap-4 text-md text-text-secondary sm:flex"
              aria-label="Primary"
            >
              <Link
                href="/"
                aria-current="page"
                className="-mb-px inline-flex items-center border-b-2 border-primary px-1.5 pt-1 pb-2 font-semibold text-primary-strong transition-colors"
              >
                {t('nav.upload')}
              </Link>
            </nav>
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="p-2 text-text-secondary hover:text-text-main sm:hidden"
              aria-label="Toggle menu"
            >
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d={isMenuOpen ? 'M6 18L18 6M6 6l12 12' : 'M4 6h16M4 12h16M4 18h16'}
                />
              </svg>
            </button>
            <div className="flex items-center gap-3.5">
              <LanguageSwitcher />
              {rightSlot}
            </div>
          </div>
        </div>
      </header>

      {isMenuOpen && (
        <>
          <div
            className="menu-fade-in fixed inset-0 z-40 h-full w-full bg-black/30 sm:hidden"
            onClick={() => setIsMenuOpen(false)}
          />
          <div className="fixed left-0 top-0 z-50 flex w-full flex-col sm:hidden">
            <div className="menu-fade-in border-t border-border-subtle bg-white">
              <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                <span className="text-xl font-bold tracking-tight text-[#16A34A]">KysoQR</span>
                <button
                  onClick={() => setIsMenuOpen(false)}
                  className="p-2 text-text-secondary hover:text-text-main"
                  aria-label="Close menu"
                >
                  <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
              <nav className="flex flex-col gap-0 px-4 py-4 text-md font-semibold text-text-secondary">
                <Link
                  href="/"
                  onClick={() => setIsMenuOpen(false)}
                  className="rounded bg-surface-soft px-4 py-3 text-primary-strong"
                >
                  {t('nav.upload')}
                </Link>
              </nav>
            </div>
          </div>
        </>
      )}
    </>
  );
}
