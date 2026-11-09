'use client';

import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import { InlineSpinner } from '@/components/signing/Spinners';
import { isRegistrationOpen } from '@/lib/vneid/client/polling';
import type { VneidRegistration } from '@/lib/vneid/client/vneidApi';
import { buttonClass, Notice } from './ui';

/**
 * Where a certificate registration stands: waiting on the citizen (share the
 * details, then activate the certificate in VNeID), done, or ended without a
 * certificate -- with a way to try again. Shown in the VNeID signer panel; it
 * comes back after a reload once the same CCCD is typed and the certificates
 * are fetched again.
 */
export function VneidRegistrationCard({
  registration,
  pollError,
  onRegisterAgain,
  disabled,
}: {
  registration: VneidRegistration;
  pollError: string | null;
  onRegisterAgain: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const open = isRegistrationOpen(registration.status);
  const done = registration.status === 'COMPLETED';

  return (
    <Notice tone={open ? 'info' : done ? 'success' : 'error'}>
      <div className="flex items-start gap-2" aria-live="polite">
        <span className="mt-0.5 shrink-0">
          {open ? (
            <InlineSpinner />
          ) : done ? (
            <Icon icon="lucide:circle-check-big" className="h-4 w-4 text-primary" />
          ) : (
            <Icon icon="lucide:alert-triangle" className="h-4 w-4 text-error-text" />
          )}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-semibold text-text-main">{t('vneid.register.cardTitle')}</p>
          <p className="text-text-muted">
            {registration.providerName} · {registration.servicePackName}
          </p>
          <p className={done ? 'text-primary-strong' : open ? 'text-text-main' : 'text-error-text'}>
            {t(`vneid.register.status.${registration.status}`)}
            {registration.reason ? ` ${t(`vneid.register.reason.${registration.reason}`)}` : ''}
          </p>
          {open && (
            <>
              <ol className="list-decimal space-y-0.5 pl-4 text-text-secondary">
                <li>{t('vneid.register.waitStep1')}</li>
                <li>{t('vneid.register.waitStep2')}</li>
                <li>{t('vneid.register.waitStep3')}</li>
              </ol>
              <p className="text-[11px] text-text-muted">{t('vneid.register.reloadHint')}</p>
            </>
          )}
          {done && <p className="text-text-secondary">{t('vneid.register.completedHint')}</p>}
          {pollError && <p className="text-[11px] text-error-text">{pollError}</p>}
          {!open && !done && (
            <button
              type="button"
              onClick={onRegisterAgain}
              disabled={disabled}
              className={`mt-1 ${buttonClass('secondary', 'sm')}`}
            >
              {t('vneid.register.again')}
            </button>
          )}
        </div>
      </div>
    </Notice>
  );
}
