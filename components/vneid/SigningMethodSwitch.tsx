'use client';

import { useTranslation } from 'react-i18next';

export type SigningMethod = 'casid' | 'vneid';

const METHODS: SigningMethod[] = ['casid', 'vneid'];

/** Cas ID (QR) or VNeID -- same radio style as SignerConfigPanel's signer kind. */
export function SigningMethodSwitch({
  value,
  onChange,
  disabled,
}: {
  value: SigningMethod;
  onChange: (method: SigningMethod) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-3">
      <span className="block text-xs font-medium text-text-main">{t('vneid.methodLabel')}</span>
      <div
        role="radiogroup"
        aria-label={t('vneid.methodLabel')}
        className="mt-1 grid grid-cols-2 gap-2"
      >
        {METHODS.map((method) => {
          const active = value === method;
          return (
            <button
              key={method}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(method)}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
                active
                  ? 'border-primary bg-surface-soft text-primary'
                  : 'border-border-subtle bg-white text-text-secondary hover:border-primary'
              }`}
            >
              {method === 'vneid' && (
                // eslint-disable-next-line @next/next/no-img-element -- tiny static brand mark
                <img src="/brand/vneid.svg" alt="" aria-hidden="true" className="h-4 w-4" />
              )}
              {t(`vneid.methods.${method}`)}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[11px] text-text-muted">{t(`vneid.methodHint.${value}`)}</p>
    </div>
  );
}
