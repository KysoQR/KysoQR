'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';

/**
 * Shown once, the moment a signing round ends without a signature while the
 * user is on the page -- the counterpart of DownloadReminderModal (SIGNED),
 * same card. Declined (REJECTED), expired, or a technical failure, with the
 * two ways forward: "Ký lại" (same file, boxes back) or "Ký tài liệu mới".
 * Closing it (X / Esc / backdrop) leaves the failed screen, whose right pane
 * offers the same two buttons.
 */

const VARIANTS = {
  REJECTED: { icon: 'lucide:x-circle', circle: 'bg-red-50 text-red-600', key: 'rejected' },
  EXPIRED: { icon: 'lucide:clock-alert', circle: 'bg-amber-50 text-amber-600', key: 'expired' },
  FAILED: { icon: 'lucide:triangle-alert', circle: 'bg-red-50 text-red-600', key: 'failed' },
} as const;

export function SignFailedModal({
  status,
  onRetry,
  onSignNewDocument,
  onClose,
}: {
  status: string | null;
  onRetry: () => void;
  onSignNewDocument: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const variant = VARIANTS[status as keyof typeof VARIANTS] ?? VARIANTS.FAILED;
  const title = t(`signFailedNotice.${variant.key}Title`);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-sm rounded-2xl border border-border-subtle bg-white p-6 text-center shadow-xl">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          title={t('common.close')}
          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-gray-100 hover:text-text-main"
        >
          <Icon icon="lucide:x" className="h-4 w-4" />
        </button>
        <div className={`mx-auto flex h-12 w-12 items-center justify-center rounded-full ${variant.circle}`}>
          <Icon icon={variant.icon} className="h-6 w-6" />
        </div>
        <h2 className="mt-4 text-lg font-semibold text-text-main">{title}</h2>
        <p className="mt-2 text-sm text-text-muted">{t(`signFailed.${variant.key}Note`)}</p>

        <div className="mt-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center justify-center gap-1.5 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-strong"
          >
            <Icon icon="lucide:rotate-ccw" className="h-4 w-4" />
            {t('signStatus.retry')}
          </button>
          <button
            type="button"
            onClick={onSignNewDocument}
            className="inline-flex items-center justify-center gap-1.5 rounded-full border border-primary bg-white px-5 py-2.5 text-sm font-semibold text-primary shadow-sm transition hover:bg-surface-soft-strong"
          >
            <Icon icon="lucide:file-plus" className="h-4 w-4" />
            {t('signStatus.signNewDocument')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
