'use client';

import { useTranslation } from 'react-i18next';
import type { VneidLanguage, VneidProvider, VneidServicePack } from '@/lib/vneid/client/vneidApi';
import { getProviderLogo } from '@/lib/vneid/providerLogos';
import { formatPrice } from './PackPicker';

/**
 * What has been picked so far, on top of the pack and form steps: the
 * provider (logo, name, code, number of packs) and, once chosen, the pack
 * (code, length, price) -- with a way back to change them.
 */
export function SelectedPackBanner({
  provider,
  pack,
  language,
  onChange,
  changeLabel,
  disabled,
}: {
  provider: VneidProvider;
  pack: VneidServicePack | null;
  language: VneidLanguage;
  onChange: () => void;
  changeLabel: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const brand = getProviderLogo(provider.provider, provider.name);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-surface-soft px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        {brand ? (
          <span className="flex h-10 w-16 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-white p-1">
            {/* eslint-disable-next-line @next/next/no-img-element -- static brand mark */}
            <img src={brand.logo} alt={brand.alt} className="h-full w-full object-contain" />
          </span>
        ) : (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-xs font-bold text-white">
            CA
          </span>
        )}
        {pack ? (
          <span className="min-w-0">
            <span className="block text-xs font-bold text-text-main">
              {provider.name} · {pack.name}
            </span>
            <span className="block text-[11px] text-text-secondary">
              #{pack.code}
              {pack.months !== null
                ? ` · ${t('vneid.register.months', { count: pack.months })}`
                : ''}{' '}
              ·{' '}
              <span className="font-semibold text-primary-strong">
                {formatPrice(pack, language, t('vneid.register.free'))}
              </span>
            </span>
          </span>
        ) : (
          <span className="min-w-0">
            <span className="block text-xs font-bold text-text-main">{provider.name}</span>
            <span className="block text-[11px] text-text-secondary">
              <span className="font-mono">{provider.provider}</span> ·{' '}
              {t('vneid.register.packCount', { count: provider.packs.length })}
            </span>
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={onChange}
        disabled={disabled}
        className="text-xs font-semibold text-primary hover:underline disabled:opacity-60"
      >
        {changeLabel}
      </button>
    </div>
  );
}
