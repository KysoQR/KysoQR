'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from './LanguageSwitcher';
import { GithubStarsButton } from './GithubStarsButton';
import { useWhyMenu } from './WhyMenu';

/** `usePathname()` may or may not include the trailing slash depending on the
 * router, so compare the path without one. */
function samePath(pathname: string, matchPath: string): boolean {
  const strip = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);
  return strip(pathname) === strip(matchPath);
}

/** Two-line items, same stacking as the Cas ID header: a short kicker on top,
 * the name in bold underneath. "Vì sao / Ký số QR" is omitted unless the
 * server has `public/why.html`. `/` matches no item. */
const NAV_ITEMS: {
  key: string;
  href: string;
  matchPath: string | null;
  kickerKey: string;
  labelKey: string;
}[] = [
  {
    key: 'why',
    href: '/why.html',
    matchPath: null,
    kickerKey: 'nav.whyKicker',
    labelKey: 'nav.whyLabel',
  },
  {
    key: 'opensource',
    href: '/opensource/',
    matchPath: '/opensource',
    kickerKey: 'nav.openSourceKicker',
    labelKey: 'nav.openSourceLabel',
  },
  {
    key: 'api',
    href: '/api/',
    matchPath: '/api',
    kickerKey: 'nav.apiKicker',
    labelKey: 'nav.apiLabel',
  },
  {
    key: 'verify',
    href: '/verify/',
    matchPath: '/verify',
    kickerKey: 'nav.verifyKicker',
    labelKey: 'nav.verifyLabel',
  },
];

function NavLines({
  kicker,
  label,
  align,
}: {
  kicker: string;
  label: string;
  align: 'center' | 'start';
}) {
  return (
    <span className={`flex flex-col leading-tight ${align === 'center' ? 'items-center' : 'items-start'}`}>
      <span className="text-[13px] font-medium text-text-secondary">{kicker}</span>
      <span className="mt-0.5 text-sm font-bold tracking-[-0.02em] text-text-main">{label}</span>
    </span>
  );
}

/** Simplified port of x-sign-web/src/components/Header.tsx — two-line nav
 * (kicker + bold name), plus the GitHub/star button on every page, `rightSlot`
 * kept so the home page's "Dùng thử miễn phí" CTA still works exactly like the
 * original.
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
  const pathname = usePathname();
  const showWhy = useWhyMenu();
  const navItems = NAV_ITEMS.filter((item) => item.key !== 'why' || showWhy);

  return (
    <>
      <header className="bg-white/95 backdrop-blur">
        <div
          className={`mx-auto flex h-[72px] items-center px-4 sm:px-6 lg:grid lg:grid-cols-[1fr_auto_1fr] ${maxWidthClassName}`}
        >
          <Link href="/" onClick={onLogoClick} className="flex w-fit shrink-0 items-center justify-self-start gap-0">
            {/* eslint-disable-next-line @next/next/no-img-element -- small static logo image, no optimization needed */}
            <img
              src="/kysoqr-logo.png"
              alt="KysoQR"
              className="h-[22.4px] w-auto object-contain sm:h-[28.8px]"
            />
          </Link>

          {/* Wide screens: menu sits in the middle track, so it is centered
              between the logo and the language cluster. The two `1fr` tracks
              stay equal, which is what actually centers this group. */}
          <div className="hidden items-center justify-center gap-4 lg:flex">
            {centerContent}
            <nav className="flex items-center gap-1 xl:gap-2" aria-label="Primary">
              {navItems.map((item) => {
                const lines = (
                  <NavLines kicker={t(item.kickerKey)} label={t(item.labelKey)} align="center" />
                );
                const active = item.matchPath != null && samePath(pathname, item.matchPath);
                const itemClass = `rounded-lg px-2 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40 hover:bg-surface-soft ${
                  active ? 'bg-surface-soft' : ''
                }`;
                if (item.key === 'why') {
                  return (
                    <a key={item.key} href={item.href} className={itemClass}>
                      {lines}
                    </a>
                  );
                }
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={itemClass}
                  >
                    {lines}
                  </Link>
                );
              })}
            </nav>
          </div>
          <div className="ml-auto flex shrink-0 items-center justify-end gap-1 lg:ml-0 lg:justify-self-end lg:gap-6">
            {showWhy && (
              <a
                href="/why.html"
                className="rounded-lg px-1.5 py-1 outline-none transition-colors hover:bg-surface-soft focus-visible:ring-2 focus-visible:ring-primary/40 lg:hidden"
              >
                <NavLines
                  kicker={t('nav.whyKicker')}
                  label={t('nav.whyLabel')}
                  align="center"
                />
              </a>
            )}
            <div className="flex items-center gap-3.5">
              <span className="hidden lg:inline-flex">
                <GithubStarsButton />
              </span>
              <LanguageSwitcher />
              {rightSlot}
            </div>
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className="p-2 text-text-secondary hover:text-text-main lg:hidden"
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
          </div>
        </div>
      </header>

      {isMenuOpen && (
        <>
          <div
            className="menu-fade-in fixed inset-0 z-40 h-full w-full bg-black/30 lg:hidden"
            onClick={() => setIsMenuOpen(false)}
          />
          <div className="fixed left-0 top-0 z-50 flex w-full flex-col lg:hidden">
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
              <nav className="flex flex-col gap-1 px-4 py-4">
                {navItems.map((item) => {
                  const lines = (
                    <NavLines kicker={t(item.kickerKey)} label={t(item.labelKey)} align="start" />
                  );
                  const active = item.matchPath != null && samePath(pathname, item.matchPath);
                  const itemClass = `rounded-lg px-3 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40 hover:bg-surface-soft ${
                    active ? 'bg-surface-soft' : ''
                  }`;
                  if (item.key === 'why') {
                    return (
                      <a key={item.key} href={item.href} className={itemClass}>
                        {lines}
                      </a>
                    );
                  }
                  return (
                    <Link
                      key={item.key}
                      href={item.href}
                      onClick={() => setIsMenuOpen(false)}
                      className={itemClass}
                    >
                      {lines}
                    </Link>
                  );
                })}
              </nav>
            </div>
          </div>
        </>
      )}

    </>
  );
}
