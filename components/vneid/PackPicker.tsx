'use client';

import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import type { VneidLanguage, VneidProvider, VneidServicePack } from '@/lib/vneid/client/vneidApi';
import { Badge, choiceCardClass, Notice } from './ui';

type PackFilter = 'all' | 'free' | 'paid';
const FILTERS: PackFilter[] = ['all', 'free', 'paid'];
const FILTER_LABEL: Record<PackFilter, string> = {
  all: 'vneidPage.filterAll',
  free: 'vneidPage.filterFree',
  paid: 'vneidPage.filterPaid',
};

export function formatPrice(pack: VneidServicePack, language: VneidLanguage, free: string) {
  if (pack.free) return free;
  if (pack.unitPrice === null) return '?';
  return new Intl.NumberFormat(language === 'en' ? 'en-US' : 'vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0,
  }).format(pack.unitPrice);
}

/**
 * The packs of one provider: a free / paid filter, a grid of cards with the
 * price, length and code, and a note when the picked pack is not free. Used
 * on the VNeID page and in the register popup; `heading` sits left of the
 * filter. Keyed by position and picked by identity: CSign lists some packs
 * twice under one code (seen: VNPT 18130).
 */
export function PackPicker({
  provider,
  selected,
  onSelect,
  language,
  columns,
  heading,
}: {
  provider: VneidProvider;
  selected: VneidServicePack | null;
  onSelect: (pack: VneidServicePack) => void;
  language: VneidLanguage;
  columns: string;
  heading?: ReactNode;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<PackFilter>('all');
  const freeLabel = t('vneid.register.free');
  const packs = provider.packs.filter((pack) =>
    filter === 'free' ? pack.free : filter === 'paid' ? !pack.free : true
  );

  return (
    <div>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">{heading}</div>
        <div className="inline-flex self-start rounded-xl border border-border-subtle bg-page-bg p-1 text-xs sm:self-auto">
          {FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
              className={`rounded-lg px-3 py-1 font-medium transition ${
                filter === key
                  ? 'bg-white font-semibold text-primary-strong shadow-2xs'
                  : 'text-text-secondary hover:text-text-main'
              }`}
            >
              {t(FILTER_LABEL[key])}
            </button>
          ))}
        </div>
      </div>

      {packs.length === 0 ? (
        <p className="py-4 text-xs text-text-muted">{t('vneid.register.noPacks')}</p>
      ) : (
        <div
          role="radiogroup"
          aria-label={t('vneid.register.titles.pack')}
          className={`grid gap-3 ${columns}`}
        >
          {packs.map((item, index) => {
            const active = selected === item;
            return (
              <button
                key={`${item.code}-${index}`}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onSelect(item)}
                className={`flex flex-col justify-between rounded-xl border p-3.5 text-left transition ${choiceCardClass(active)}`}
              >
                <span className="block">
                  <span className="flex items-start justify-between gap-2">
                    <Badge tone={item.free ? 'success' : 'warning'}>
                      {formatPrice(item, language, freeLabel)}
                    </Badge>
                    <span className="font-mono text-[11px] text-text-muted">#{item.code}</span>
                  </span>
                  <span className="mt-2 block text-sm font-bold text-text-main">{item.name}</span>
                </span>
                <span className="mt-3 flex items-center justify-between border-t border-border-subtle/80 pt-2 text-xs">
                  <span className="inline-flex items-center gap-1 font-medium text-text-secondary">
                    {item.months !== null && (
                      <>
                        <Icon icon="lucide:clock" className="h-3.5 w-3.5" />
                        {t('vneid.register.months', { count: item.months })}
                      </>
                    )}
                  </span>
                  <Icon
                    icon={active ? 'lucide:check' : 'lucide:arrow-right'}
                    className={`h-4 w-4 ${active ? 'text-primary-strong' : 'text-text-muted'}`}
                  />
                </span>
              </button>
            );
          })}
        </div>
      )}

      {selected && !selected.free && (
        <Notice tone="warning" className="mt-3 flex items-start gap-2">
          <Icon icon="lucide:info" className="mt-0.5 h-4 w-4 shrink-0 text-warning-strong" />
          <span>
            {t('vneid.register.paidNote', { price: formatPrice(selected, language, freeLabel) })}
          </span>
        </Notice>
      )}
    </div>
  );
}
