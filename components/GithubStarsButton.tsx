'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';

const GITHUB_URL = 'https://github.com/KysoQR/KysoQR';
const GITHUB_REPO_API_URL = 'https://api.github.com/repos/KysoQR/KysoQR';

/**
 * GitHub link + live star count, rendered by `Header` on every page.
 *
 * The count is fetched straight from the visitor's browser on every load
 * (`no-cache` revalidates with GitHub each time), so it's always current and
 * each visitor spends their own IP's 60 requests/hour unauthenticated quota
 * -- not a shared server quota that every visitor would exhaust together.
 * Decoration only: on any failure (quota spent, offline) the button just
 * shows the logo without a count.
 */
export function GithubStarsButton() {
  const { t } = useTranslation();
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(GITHUB_REPO_API_URL, {
      cache: 'no-cache',
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { stargazers_count?: unknown } | null) => {
        if (!cancelled && typeof body?.stargazers_count === 'number') {
          setStars(body.stargazers_count);
        }
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
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-full border border-border-subtle bg-white text-text-main shadow-sm transition-colors hover:border-primary hover:text-primary ${
        stars === null ? 'w-9' : 'px-3'
      }`}
    >
      <Icon icon="simple-icons:github" className="h-5 w-5" />
      {stars !== null && (
        <span className="inline-flex items-center gap-1 text-sm font-semibold">
          <Icon icon="lucide:star" className="h-4 w-4" />
          {new Intl.NumberFormat('en', { notation: 'compact' }).format(stars)}
        </span>
      )}
    </a>
  );
}
