'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';

const GITHUB_URL = 'https://github.com/KysoQR/KysoQR/';
/** Shields caches GitHub's count on their side, so this does not spend the
 * visitor's unauthenticated api.github.com quota (60 requests/hour/IP). */
const SHIELDS_STARS_URL = 'https://img.shields.io/github/stars/KysoQR/KysoQR.json';
const STARS_CACHE_KEY = 'kysoqr.githubStars';
const STARS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type StarsCache = { count: number; at: number };

function parseStarCount(value: string): number | null {
  const cleaned = value.trim().toLowerCase().replace(/,/g, '');
  if (/^\d+$/.test(cleaned)) return Number(cleaned);
  const metric = cleaned.match(/^(\d+(?:\.\d+)?)([km])$/);
  if (!metric) return null;
  const amount = Number(metric[1]);
  return Math.round(amount * (metric[2] === 'k' ? 1_000 : 1_000_000));
}

function readStarsCache(): StarsCache | null {
  try {
    const raw = localStorage.getItem(STARS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { count?: unknown; at?: unknown };
    if (typeof parsed.count !== 'number' || typeof parsed.at !== 'number') return null;
    return { count: parsed.count, at: parsed.at };
  } catch {
    return null;
  }
}

function writeStarsCache(count: number) {
  try {
    const entry: StarsCache = { count, at: Date.now() };
    localStorage.setItem(STARS_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // localStorage unavailable/full/disabled -- the count still shows this visit.
  }
}

/**
 * GitHub link + star count, rendered by `Header` on every page.
 *
 * The count comes from Shields (a cached proxy), then stays in localStorage
 * for six hours. Calling api.github.com from the browser on every load was
 * burning the IP's 60 unauthenticated requests/hour, including during dev
 * reloads. Decoration only: on failure with nothing cached, the button shows
 * the logo and no count.
 */
export function GithubStarsButton() {
  const { t } = useTranslation();
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    const cached = readStarsCache();
    // localStorage is browser-only. Reading it in a useState initializer would
    // run during SSR and mismatch on hydration, so the cache is applied once
    // after mount.
    if (cached) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStars(cached.count);
    }
    if (cached && Date.now() - cached.at < STARS_CACHE_TTL_MS) return;

    let cancelled = false;
    fetch(SHIELDS_STARS_URL)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { value?: unknown; message?: unknown } | null) => {
        const raw = typeof body?.value === 'string' ? body.value : body?.message;
        const count = typeof raw === 'string' ? parseStarCount(raw) : null;
        if (cancelled || count === null) return;
        setStars(count);
        writeStarsCache(count);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const label =
    stars === null
      ? t('home.githubLink')
      : `${t('home.githubLink')} (${t('home.githubStars', { count: stars })})`;

  return (
    <a
      href={GITHUB_URL}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
      className="inline-flex h-9 items-center justify-center gap-1.5 text-text-main transition-colors hover:text-primary"
    >
      <Icon icon="simple-icons:github" className="h-5 w-5" />
      {stars !== null && (
        <span className="inline-flex items-center gap-0.5 text-sm font-semibold tabular-nums">
          {new Intl.NumberFormat('en', { notation: 'compact' }).format(stars)}
          <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3 fill-current">
            <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Zm0 2.445L6.615 5.5a.75.75 0 0 1-.564.41l-3.097.45 2.24 2.184a.75.75 0 0 1 .216.664l-.528 3.084 2.769-1.456a.75.75 0 0 1 .698 0l2.77 1.456-.53-3.084a.75.75 0 0 1 .216-.664l2.24-2.183-3.096-.45a.75.75 0 0 1-.564-.41L8 2.694Z" />
          </svg>
        </span>
      )}
    </a>
  );
}
