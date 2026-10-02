'use client';

import { Icon } from '@iconify/react';
import { useTranslation } from 'react-i18next';
import { Reveal } from '../Reveal';
import { CAS_ID_GUIDE_VIDEO_EMBED_URL, CAS_ID_REGISTER_URL } from '@/lib/branding/signingMethods';

/** Anchor id, used by the scan step's ScrollCue. */
export const CAS_ID_VIDEO_GUIDE_ID = 'cas-id-video-guide';

const POINT_KEYS = ['buttons', 'flow', 'mistakes'] as const;

/**
 * Below the QR card in step 2 ("Quét QR"): a walkthrough video for anyone
 * who doesn't have CAS ID / a CAS CERT certificate yet, plus a link to the
 * free registration page.
 */
export function CasIdVideoGuide() {
  const { t } = useTranslation();

  return (
    <section
      id={CAS_ID_VIDEO_GUIDE_ID}
      aria-labelledby="cas-id-video-guide-title"
      className="mt-10 scroll-mt-28"
    >
      <Reveal className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-14">
        <div className="flex flex-col items-start gap-5">
          <span className="rounded-full border border-border-subtle bg-white px-3.5 py-1.5 text-xs font-semibold uppercase tracking-widest text-primary-strong">
            {t('scan.videoGuide.eyebrow')}
          </span>
          <h2
            id="cas-id-video-guide-title"
            className="text-3xl font-semibold leading-tight tracking-tight text-text-main sm:text-[40px]"
          >
            {t('scan.videoGuide.title')}
          </h2>
          <ul className="flex flex-col gap-3">
            {POINT_KEYS.map((key) => (
              <li key={key} className="flex items-start gap-3 text-[15px] text-text-secondary">
                <Icon
                  icon="lucide:check"
                  className="mt-1 h-4 w-4 shrink-0 text-primary-strong"
                  aria-hidden="true"
                />
                <span>{t(`scan.videoGuide.points.${key}`)}</span>
              </li>
            ))}
          </ul>
          <a
            href={CAS_ID_REGISTER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="animate-cta-glow inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-strong"
          >
            {t('home.branding.registerFree')}
            <Icon icon="lucide:arrow-up-right" className="h-4 w-4" aria-hidden="true" />
          </a>
        </div>

        <div className="overflow-hidden rounded-[20px] bg-black shadow-xl shadow-primary/10 ring-1 ring-border-subtle">
          <iframe
            src={CAS_ID_GUIDE_VIDEO_EMBED_URL}
            title={t('scan.videoGuide.videoTitle')}
            loading="lazy"
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
            className="aspect-video h-auto w-full border-0"
          />
        </div>
      </Reveal>
    </section>
  );
}
