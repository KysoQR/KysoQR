'use client';

import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import { ExpiresIn } from '@/components/signing/ExpiresIn';
import { formatFileSize } from '@/components/signing/constants';

/**
 * Right pane of the signing wizard after "Ký" was pressed, until the round
 * succeeds: the file, the round's status, and what can be done now.
 *
 * - Waiting (PENDING/ACCEPTED): "Mở lại mã QR" + "Ký yêu cầu mới" (the
 *   latter hidden once the signer accepted -- CAS is already finishing).
 * - Ended without a signature (REJECTED/EXPIRED/FAILED): why, then "Ký lại"
 *   (same file, boxes back) and "Ký tài liệu mới" (empty upload area).
 *
 * A successful round shows `ReviewSignedPane` instead.
 */

type Tone = 'pending' | 'danger' | 'warning';

const FAILED_VARIANTS: Record<string, { label: string; note: string; tone: Tone; icon: string }> = {
  REJECTED: { label: 'signStatus.rejected', note: 'signFailed.rejectedNote', tone: 'danger', icon: 'lucide:x-circle' },
  EXPIRED: { label: 'signStatus.expired', note: 'signFailed.expiredNote', tone: 'warning', icon: 'lucide:clock-alert' },
  FAILED: { label: 'signStatus.failed', note: 'signFailed.failedNote', tone: 'danger', icon: 'lucide:triangle-alert' },
};

const TONE_CLASSES: Record<Tone, string> = {
  pending: 'border-amber-200 bg-amber-50 text-amber-700',
  danger: 'border-error-border bg-error-bg text-error-text',
  warning: 'border-amber-200 bg-amber-50 text-amber-700',
};

export function SigningStatusPane({
  file,
  pageCount,
  status,
  expiresAt,
  onExpired,
  onReopenQr,
  onNewRequest,
  onSignNewDocument,
}: {
  file: File | null;
  pageCount: number | null;
  /** PENDING/ACCEPTED (waiting) or REJECTED/EXPIRED/FAILED (ended). */
  status: string | null;
  expiresAt: string | null;
  onExpired: () => void;
  onReopenQr: () => void;
  onNewRequest: () => void;
  onSignNewDocument: () => void;
}) {
  const { t } = useTranslation();
  const failed = status ? FAILED_VARIANTS[status] : undefined;
  const accepted = status === 'ACCEPTED';

  return (
    <>
      {file && (
        <div className="flex shrink-0 items-center gap-3 rounded-xl border border-border-subtle bg-white px-3 py-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-500">
            <Icon icon="lucide:file-text" className="h-6 w-6" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-text-main" title={file.name}>
              {file.name}
            </div>
            <div className="mt-0.5 text-xs text-text-muted">
              {formatFileSize(file.size)}
              {pageCount ? ` · ${t('upload.pageCount', { count: pageCount })}` : ''}
            </div>
          </div>
        </div>
      )}

      <div
        role="status"
        className={`rounded-xl border px-3 py-2.5 text-xs ${TONE_CLASSES[failed?.tone ?? 'pending']}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-text-muted">{t('signStatus.title')}</span>
          <span className="inline-flex items-center gap-1.5 font-semibold">
            {failed ? (
              <Icon icon={failed.icon} className="h-3.5 w-3.5" />
            ) : (
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
            )}
            {failed ? t(failed.label) : t('signStatus.pending')}
          </span>
        </div>
        <p className="mt-1.5 text-text-secondary">
          {failed ? t(failed.note) : accepted ? t('signStatus.accepted') : t('signStatus.pendingNote')}
        </p>
        {!failed && (
          <div className="mt-1">
            <ExpiresIn expiresAt={expiresAt} onExpired={onExpired} />
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {!failed && (
          <button
            type="button"
            onClick={onReopenQr}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-primary/90"
          >
            <Icon icon="lucide:qr-code" className="h-4 w-4" />
            {t('signStatus.reopenQr')}
          </button>
        )}
        {failed ? (
          <>
            <button
              type="button"
              onClick={onNewRequest}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-primary/90"
            >
              <Icon icon="lucide:rotate-ccw" className="h-4 w-4" />
              {t('signStatus.retry')}
            </button>
            <button
              type="button"
              onClick={onSignNewDocument}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-primary bg-white px-6 py-2.5 text-sm font-semibold text-primary shadow-sm hover:bg-surface-soft-strong"
            >
              <Icon icon="lucide:file-plus" className="h-4 w-4" />
              {t('signStatus.signNewDocument')}
            </button>
          </>
        ) : (
          !accepted && (
            <button
              type="button"
              onClick={onNewRequest}
              className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-primary bg-white px-6 py-2.5 text-sm font-semibold text-primary shadow-sm hover:bg-surface-soft-strong"
            >
              <Icon icon="lucide:rotate-ccw" className="h-4 w-4" />
              {t('signStatus.newRequest')}
            </button>
          )
        )}
      </div>
    </>
  );
}
