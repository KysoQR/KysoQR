'use client';

import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import { buttonClass, Notice } from './ui';

/**
 * "This CCCD has no certificate yet", in the same warning box on the VNeID
 * page and in the signing column, with a button to register one. The box
 * follows its own width: icon, text and button on one line when there is
 * room, the button on a line of its own in a narrow column.
 */
export function NoCertificateNotice({
  text,
  onRegister,
  disabled,
  className,
}: {
  text: string;
  /** Leaves the button out when absent (e.g. a registration is already open). */
  onRegister?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className={`@container ${className ?? ''}`}>
      <Notice
        tone="warning"
        className="flex flex-wrap items-center gap-3 border-l-4 border-l-warning-strong @xl:flex-nowrap"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-warning-strong">
          <Icon icon="lucide:shield-alert" className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">{t('vneid.register.noCertificateTitle')}</p>
          <p className="mt-0.5">{text}</p>
        </div>
        {onRegister && (
          <button
            type="button"
            onClick={onRegister}
            disabled={disabled}
            className={`${buttonClass('primary', 'sm')} w-full shrink-0 @xl:w-auto`}
          >
            <Icon icon="lucide:plus" className="h-3.5 w-3.5" />
            {t('vneid.register.openButton')}
          </button>
        )}
      </Notice>
    </div>
  );
}
