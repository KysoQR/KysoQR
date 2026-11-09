'use client';

import { useTranslation } from 'react-i18next';
import type { VneidProvider } from '@/lib/vneid/client/vneidApi';
import { getProviderLogo } from '@/lib/vneid/providerLogos';
import { Badge, choiceCardClass, RadioDot } from './ui';

/**
 * The certificate providers as a grid of cards (logo, name, code, number of
 * packs, "has a free pack"), on the VNeID page and in the register popup.
 * `columns` sets how many fit per screen size. Picked by identity and keyed
 * by position: CSign provider codes need not be unique.
 */
export function ProviderGrid({
  providers,
  selected,
  onSelect,
  columns,
}: {
  providers: VneidProvider[];
  selected: VneidProvider | null;
  onSelect: (provider: VneidProvider) => void;
  columns: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="radiogroup"
      aria-label={t('vneid.register.titles.provider')}
      className={`grid gap-3 ${columns}`}
    >
      {providers.map((item, index) => {
        const active = selected === item;
        const brand = getProviderLogo(item.provider, item.name);
        return (
          <button
            key={`${item.provider}-${index}`}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(item)}
            className={`group flex flex-col justify-between rounded-xl border p-3 text-left transition ${choiceCardClass(active)}`}
          >
            <span className="flex items-start justify-between gap-2">
              <span className="flex h-8 items-center">
                {brand ? (
                  // eslint-disable-next-line @next/next/no-img-element -- static brand mark
                  <img
                    src={brand.logo}
                    alt={brand.alt}
                    className="h-8 max-w-[130px] object-contain object-left transition group-hover:scale-105"
                    loading="lazy"
                  />
                ) : (
                  <span className="inline-flex h-8 items-center rounded-lg bg-surface-soft-strong px-2.5 text-xs font-black tracking-wide text-primary-strong">
                    {item.provider.slice(0, 4).toUpperCase()}
                  </span>
                )}
              </span>
              <RadioDot active={active} />
            </span>
            <span className="mt-2 block">
              <span
                className="line-clamp-2 min-h-10 text-sm font-bold leading-snug text-text-main"
                title={item.name}
              >
                {item.name}
              </span>
              <span className="mt-0.5 block font-mono text-[11px] text-text-muted">
                {item.provider}
              </span>
            </span>
            <span className="mt-2 flex items-center justify-between gap-2 border-t border-border-subtle/80 pt-2 text-[11px]">
              <span className="font-semibold text-primary-strong">
                {t('vneid.register.packCount', { count: item.packs.length })}
              </span>
              {item.packs.some((pack) => pack.free) && (
                <Badge tone="success">{t('vneidPage.hasFreeBadge')}</Badge>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
