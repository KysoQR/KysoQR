'use client';

import { useTranslation } from 'react-i18next';
import { TextField } from '@/components/TextField';
import type { RegistrationFormState } from '@/lib/vneid/client/useRegistrationForm';
import { GENDERS, type RegistrationField, REQUIRED_FIELDS } from '@/lib/vneid/registrationForm';

const SELECT_CLASS =
  'w-full rounded-lg border bg-white px-3 py-1.5 text-sm text-text-main shadow-sm outline-none focus:ring-2 disabled:bg-gray-50';
const HEADING_CLASS = 'mb-2 text-xs font-bold uppercase tracking-wider text-primary-strong';
/** Address, then ward and city -- all on one row once the part is wide enough. */
const ADDRESS_GRID = 'grid gap-3 @md:grid-cols-2 @2xl:grid-cols-4';

/**
 * The registration form in three parts -- identity and contact, permanent
 * address, current address (or "same as permanent") -- then the consent box.
 * The same on the VNeID page (CCCD typed here) and in the register popup
 * (CCCD fixed: `citizenPid.onChange` left out). Columns follow the width the
 * form actually gets (container queries), not the screen: the page is wider
 * than the popup, and on a wide page the form fits one screen.
 */
export function RegistrationFormFields({
  state,
  idPrefix,
  citizenPid,
  disabled,
}: {
  state: RegistrationFormState;
  idPrefix: string;
  citizenPid: { value: string; onChange?: (value: string) => void; error?: string | null };
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const { form, problems, sameAddress } = state;

  const problemText = (name: RegistrationField) => {
    const problem = problems[name];
    return problem ? t(`vneid.register.problem.${problem}`) : null;
  };

  const field = (
    name: RegistrationField,
    extra: {
      type?: string;
      maxLength?: number;
      disabled?: boolean;
      autoComplete?: string;
      placeholder?: string;
    } = {}
  ) => (
    <TextField
      id={`${idPrefix}-${name}`}
      label={t(`vneid.register.fields.${name}`)}
      value={form[name]}
      onChange={(value) => state.setField(name, value)}
      error={problemText(name)}
      required={REQUIRED_FIELDS.has(name)}
      disabled={disabled || extra.disabled}
      type={extra.type ?? 'text'}
      maxLength={extra.maxLength}
      autoComplete={extra.autoComplete ?? 'off'}
      placeholder={extra.placeholder}
    />
  );

  return (
    <div className="@container">
      <fieldset aria-labelledby={`${idPrefix}-identity`} className="min-w-0">
        <p id={`${idPrefix}-identity`} className={HEADING_CLASS}>
          {t('vneidPage.sectionIdentity')}
        </p>
        <div className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4 @7xl:grid-cols-5">
          <TextField
            id={`${idPrefix}-citizenPid`}
            label={t('vneid.register.fields.citizenPid')}
            value={citizenPid.value}
            onChange={citizenPid.onChange ?? (() => undefined)}
            error={citizenPid.error}
            required
            readOnly={!citizenPid.onChange}
            inputMode="numeric"
            maxLength={12}
            placeholder="001099012345"
            disabled={disabled || !citizenPid.onChange}
          />
          {field('fullName', { autoComplete: 'name', placeholder: 'NGUYỄN VĂN A' })}
          {field('birthDate', { type: 'date' })}
          <div className="space-y-1">
            <label
              htmlFor={`${idPrefix}-gender`}
              className="block text-xs font-medium text-text-main"
            >
              {t('vneid.register.fields.gender')}
              <span className="ml-0.5 text-error-text">*</span>
            </label>
            <select
              id={`${idPrefix}-gender`}
              value={form.gender}
              onChange={(event) => state.setField('gender', event.target.value)}
              disabled={disabled}
              aria-invalid={problems.gender ? true : undefined}
              className={`${SELECT_CLASS} ${
                problems.gender
                  ? 'border-error-border focus:border-error-text focus:ring-error-text/30'
                  : 'border-border-subtle focus:border-primary focus:ring-primary/30'
              }`}
            >
              <option value="">{t('vneid.register.selectGender')}</option>
              <option value={GENDERS[0]}>{t('vneid.register.genders.male')}</option>
              <option value={GENDERS[1]}>{t('vneid.register.genders.female')}</option>
            </select>
            {problems.gender && (
              <p className="mt-0.5 text-[11px] text-error-text">{problemText('gender')}</p>
            )}
          </div>
          {field('phone', { type: 'tel', autoComplete: 'tel', placeholder: '0901234567' })}
          {field('email', {
            type: 'email',
            autoComplete: 'email',
            placeholder: 'name@example.com',
          })}
          {field('nationalityCode', { maxLength: 2, placeholder: 'VN' })}
          {field('issuingAuthority')}
          {field('dateOfIssue', { type: 'date' })}
          {field('idCardExpireDate', { type: 'date' })}
        </div>
      </fieldset>

      {/* The two addresses side by side once the form is wide enough. */}
      <div className="mt-4 grid gap-x-6 gap-y-4 border-t border-border-subtle pt-4 @6xl:grid-cols-2">
        <fieldset aria-labelledby={`${idPrefix}-permanent`} className="min-w-0">
          <p id={`${idPrefix}-permanent`} className={HEADING_CLASS}>
            {t('vneidPage.sectionPermanent')}
          </p>
          <div className="@container">
            <div className={ADDRESS_GRID}>
              <div className="@md:col-span-2">{field('permanentAddress')}</div>
              {field('permanentVillageText')}
              {field('permanentCityText')}
            </div>
          </div>
        </fieldset>

        <fieldset aria-labelledby={`${idPrefix}-living`} className="min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-x-3">
            <p id={`${idPrefix}-living`} className={HEADING_CLASS}>
              {t('vneidPage.sectionLiving')}
            </p>
            <label className="mb-2 flex items-center gap-2 text-xs font-medium text-text-secondary">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={sameAddress}
                disabled={disabled}
                onChange={(event) => state.toggleSameAddress(event.target.checked)}
              />
              <span>{t('vneid.register.sameAddress')}</span>
            </label>
          </div>
          <div className="@container">
            <div className={ADDRESS_GRID}>
              <div className="@md:col-span-2">
                {field('livingPlaceAddress', { disabled: sameAddress })}
              </div>
              {field('livingPlaceVillageText', { disabled: sameAddress })}
              {field('livingPlaceCityText', { disabled: sameAddress })}
            </div>
          </div>
        </fieldset>
      </div>

      <label className="mt-4 flex items-start gap-2.5 rounded-xl border border-border-subtle bg-page-bg px-3.5 py-2 text-xs text-text-secondary">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
          checked={state.consent}
          disabled={disabled}
          onChange={(event) => state.setConsent(event.target.checked)}
        />
        <span>{t('vneid.register.consent')}</span>
      </label>

      {(state.hasProblems || citizenPid.error) && (
        <p className="mt-3 text-xs font-medium text-error-text">
          {t('vneid.register.fixProblems')}
        </p>
      )}
    </div>
  );
}
