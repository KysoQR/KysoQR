'use client';

import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import TextField from './TextField';

export type SignerKind = 'individual' | 'enterprise';

export type CasSignerConfigValue = {
  signerKind: SignerKind;
  identificationNumber: string;
  taxCode: string;
  organizationName: string;
  representativeName: string;
};

/**
 * Simplified port of x-sign-web/src/features/intentSigning/SignerConfigPanel.tsx
 * — same fields/layout/copy, minus the IDKIT auto-fill-by-tax-code effect and
 * PDF-text-layer detected-identifier suggestions (IDKIT is not integrated in
 * v1 — signer types everything manually).
 */
export function SignerConfigPanel({
  value,
  onChange,
  disabled = false,
}: {
  value: CasSignerConfigValue;
  onChange: (next: CasSignerConfigValue) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const set = <K extends keyof CasSignerConfigValue>(key: K, next: CasSignerConfigValue[K]) =>
    onChange({ ...value, [key]: next });
  const isEnterprise = value.signerKind === 'enterprise';

  const changeSignerKind = (kind: SignerKind) => {
    if (kind === value.signerKind) return;
    onChange({
      signerKind: kind,
      identificationNumber: '',
      taxCode: '',
      organizationName: '',
      representativeName: '',
    });
  };

  const cccdError =
    value.identificationNumber && !/^\d{9}$|^\d{12}$/.test(value.identificationNumber)
      ? t('signerConfig.errors.cccd')
      : null;
  const taxCodeTrimmed = value.taxCode.trim();
  const taxCodeError =
    isEnterprise && taxCodeTrimmed && !/^\d{10}(?:-\d{3})?$/.test(taxCodeTrimmed)
      ? t('signerConfig.errors.taxCode')
      : null;

  return (
    <div className="space-y-2">
      <div>
        <span className="block text-xs font-medium text-text-main">
          {t('signerConfig.signerKindLabel')}
        </span>
        <div
          role="radiogroup"
          aria-label={t('signerConfig.signerKindLabel')}
          className="mt-1 grid grid-cols-2 gap-2"
        >
          {(['individual', 'enterprise'] as SignerKind[]).map((kind) => {
            const active = value.signerKind === kind;
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                onClick={() => changeSignerKind(kind)}
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
                  active
                    ? 'border-primary bg-surface-soft text-primary'
                    : 'border-border-subtle bg-white text-text-secondary hover:border-primary'
                }`}
              >
                {t(`signerConfig.signerKind.${kind}`)}
              </button>
            );
          })}
        </div>
        {/* One prominent line instead of a faint "Tuỳ chọn" badge on every
            field: individuals may leave everything empty (QR-only), while an
            enterprise signer must provide a tax code. */}
        <p className="mt-1.5 flex items-start gap-1 text-xs text-error-text">
          <Icon icon="lucide:info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {t(
              isEnterprise
                ? 'signerConfig.enterpriseTaxCodeRequired'
                : 'signerConfig.optionalNotice'
            )}
          </span>
        </p>
      </div>

      {isEnterprise ? (
        <>
          <TextField
            id="signer-tax-code"
            label={t('signerConfig.taxCodeLabel')}
            value={value.taxCode}
            onChange={(next) => set('taxCode', next)}
            placeholder="0316794479"
            inputMode="numeric"
            disabled={disabled}
            error={taxCodeError}
            hint={t('signerConfig.taxCodeHint')}
          />
          {/* <TextField
            id="signer-organization"
            label={t('signerConfig.organizationLabel')}
            value={value.organizationName}
            onChange={(next) => set('organizationName', next)}
            disabled={disabled}
            placeholder={t('signerConfig.organizationPlaceholder')}
          /> */}
          {/* <TextField
            id="signer-representative"
            label={t('signerConfig.representativeLabel')}
            value={value.representativeName}
            onChange={(next) => set('representativeName', next)}
            disabled={disabled}
            placeholder={t('signerConfig.representativePlaceholder')}
          /> */}
        </>
      ) : (
        <>
          <TextField
            id="signer-cccd"
            label={t('signerConfig.cccdLabel')}
            value={value.identificationNumber}
            onChange={(next) => set('identificationNumber', next)}
            placeholder="077088002778"
            inputMode="numeric"
            disabled={disabled}
            error={cccdError}
          />
          {/* <TextField
            id="signer-full-name"
            label={t('signerConfig.fullNameLabel')}
            value={value.representativeName}
            onChange={(next) => set('representativeName', next)}
            disabled={disabled}
            placeholder={t('signerConfig.fullNamePlaceholder')}
          /> */}
        </>
      )}

      {!isEnterprise && !value.identificationNumber && (
        <div className="rounded-md border border-warning-border bg-warning-bg px-3 py-1.5 text-[11px] text-warning-text">
          {t('signerConfig.noCccdWarning')}
        </div>
      )}
    </div>
  );
}

export default SignerConfigPanel;

/** Ported from x-sign-web/src/features/documents/casSignerForm.ts.
 * For an individual nothing is REQUIRED -- real signer identity is confirmed
 * afterwards in the CAS ID app during the QR step (QR-only signing is a
 * deliberate, supported path), so only a CCCD that's PRESENT but malformed is
 * rejected. An enterprise signer MUST provide a well-formed tax code (MST);
 * the server enforces the same rule (`lib/domain/CasSignerConfig.ts`).
 * `organizationName`/`representativeName` are never checked: CAS's own submit
 * call only ever receives `organizationName` when non-empty (and never
 * `representativeName` at all). */
export const isCasSignerConfigValid = (config: CasSignerConfigValue): boolean => {
  const identification = config.identificationNumber.trim();
  if (identification && !/^\d{9}$|^\d{12}$/.test(identification)) return false;
  if (config.signerKind !== 'enterprise') return true;
  return /^\d{10}(?:-\d{3})?$/.test(config.taxCode.trim());
};
