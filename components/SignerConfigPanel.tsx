'use client';

import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import TextField from './TextField';
import { SIGN_TYPES, type SignType } from '@/lib/domain/CasSignerConfig';

export type { SignType };

export type CasSignerConfigValue = {
  /** CAS `signType`: PERSONAL / BUSINESS forces how the signer signs in Cas
   * ID (they can't switch); `null` = not sent, the signer chooses. */
  signType: SignType | null;
  identificationNumber: string;
  /** Only sent with BUSINESS; kept while switching so it's still there when
   * the user switches back. */
  taxCode: string;
  organizationName: string;
  representativeName: string;
};

const CCCD = /^\d{9}$|^\d{12}$/;
const TAX_CODE = /^\d{10}(?:-\d{3})?$/;

/** The form value after a sign-type button is pressed: pressing the active
 * one clears the choice (back to "the signer chooses"). Typed values are
 * kept either way. */
export const toggleSignType = (value: CasSignerConfigValue, type: SignType): CasSignerConfigValue => ({
  ...value,
  signType: value.signType === type ? null : type,
});

/**
 * Who is signing, mirroring CAS's `signType` (same contract as the Cas Sign
 * app). Two toggles, none selected by default:
 * - none: no fields -- the signer picks personal/business in Cas ID;
 * - Cá nhân (PERSONAL): the CCCD;
 * - Doanh nghiệp (BUSINESS): the CCCD + an optional tax code (empty = any
 *   enterprise certificate, filled = that enterprise's).
 * The CCCD is optional everywhere: empty signs by QR, filled also pushes a
 * notification to that person's Cas ID.
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
  const isBusiness = value.signType === 'BUSINESS';

  const cccdError =
    value.identificationNumber && !CCCD.test(value.identificationNumber.trim())
      ? t('signerConfig.errors.cccd')
      : null;
  const taxCodeTrimmed = value.taxCode.trim();
  const taxCodeError =
    isBusiness && taxCodeTrimmed && !TAX_CODE.test(taxCodeTrimmed)
      ? t('signerConfig.errors.taxCode')
      : null;
  const hintKey =
    value.signType === 'PERSONAL'
      ? 'signerConfig.hintPersonal'
      : isBusiness
        ? 'signerConfig.hintBusiness'
        : 'signerConfig.hintNone';

  return (
    <div className="space-y-2">
      <div>
        <span className="block text-xs font-medium text-text-main">
          {t('signerConfig.signTypeLabel')}
        </span>
        {/* Toggle buttons rather than a radio group: none selected is a
            valid state (the signer chooses), reached by pressing the active
            one again. */}
        <div
          role="group"
          aria-label={t('signerConfig.signTypeLabel')}
          className="mt-1 grid grid-cols-2 gap-2"
        >
          {SIGN_TYPES.map((type) => {
            const active = value.signType === type;
            return (
              <button
                key={type}
                type="button"
                aria-pressed={active}
                disabled={disabled}
                onClick={() => onChange(toggleSignType(value, type))}
                className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
                  active
                    ? 'border-primary bg-surface-soft text-primary'
                    : 'border-border-subtle bg-white text-text-secondary hover:border-primary'
                }`}
              >
                <Icon
                  icon={type === 'BUSINESS' ? 'lucide:building-2' : 'lucide:user'}
                  className="h-3.5 w-3.5"
                />
                {t(`signerConfig.signType.${type}`)}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 flex items-start gap-1 text-xs text-primary-strong">
          <Icon icon="lucide:info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t(hintKey)}</span>
        </p>
      </div>

      {value.signType && (
        <TextField
          id="signer-cccd"
          label={t('signerConfig.cccdLabel')}
          value={value.identificationNumber}
          onChange={(next) => set('identificationNumber', next)}
          placeholder="123456789012"
          inputMode="numeric"
          disabled={disabled}
          error={cccdError}
          hint={t('signerConfig.cccdHint')}
        />
      )}

      {isBusiness && (
        <TextField
          id="signer-tax-code"
          label={t('signerConfig.taxCodeLabel')}
          value={value.taxCode}
          onChange={(next) => set('taxCode', next)}
          placeholder="0123456789 / 0123456789-001"
          inputMode="numeric"
          disabled={disabled}
          error={taxCodeError}
          hint={
            taxCodeTrimmed && !taxCodeError
              ? t('signerConfig.taxCodeFilledHint', { taxCode: taxCodeTrimmed })
              : t('signerConfig.taxCodeEmptyHint')
          }
        />
      )}

      {/* "Leave blank to sign by QR" -- whenever a CCCD field is shown and
          still empty. */}
      {value.signType && !value.identificationNumber.trim() && (
        <div className="rounded-md border border-warning-border bg-warning-bg px-3 py-1.5 text-[11px] text-warning-text">
          {t('signerConfig.noCccdWarning')}
        </div>
      )}
    </div>
  );
}

export default SignerConfigPanel;

/** Ported from x-sign-web/src/features/documents/casSignerForm.ts, updated
 * for `signType`: nothing is REQUIRED -- identity is confirmed in the Cas ID
 * app during the QR step and the tax code is optional even for BUSINESS --
 * so only a value that is PRESENT but malformed keeps "Ký" disabled (the CCCD
 * whenever a sign type is chosen, the tax code for BUSINESS only; hidden
 * fields are not sent, see SigningWizard). Same rules as the server
 * (`lib/domain/CasSignerConfig.ts`). */
export const isCasSignerConfigValid = (config: CasSignerConfigValue): boolean => {
  if (!config.signType) return true;
  const identification = config.identificationNumber.trim();
  if (identification && !CCCD.test(identification)) return false;
  if (config.signType !== 'BUSINESS') return true;
  const taxCode = config.taxCode.trim();
  return !taxCode || TAX_CODE.test(taxCode);
};
