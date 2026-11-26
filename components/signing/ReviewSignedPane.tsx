'use client';

import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import { InlineSpinner } from '@/components/signing/Spinners';
import { formatFileSize } from '@/components/signing/constants';
import type { SigningRoundDetail } from '@/lib/cas/CasProvider';
import type { RecentSignature } from '@/lib/recentSignatures';

/**
 * Right pane of the signing wizard in review mode -- a "phiên ký gần nhất"
 * reopened from the home page: the signed file, what CAS knows about the
 * round, and the 2 next actions ("Tải tài liệu về" / "Ký tiếp").
 */

function formatLocal(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="shrink-0 text-text-muted">{label}</span>
      <span className="min-w-0 text-right font-medium text-text-main">{children}</span>
    </div>
  );
}

export function ReviewSignedPane({
  file,
  pageCount,
  review,
  round,
  codeCopied,
  onCopyCode,
  onViewDetails,
  onDownload,
  onContinueSigning,
  onRemoveFile,
  onSignNewDocument,
}: {
  file: File;
  pageCount: number | null;
  review: RecentSignature;
  /** null = still loading; 'error' = lookup failed (that part just hides). */
  round: SigningRoundDetail | 'error' | null;
  codeCopied: boolean;
  onCopyCode: () => void;
  onViewDetails: (data: SigningRoundDetail) => void;
  onDownload: () => void;
  onContinueSigning: () => void;
  /** X on the file row: leave review mode, back to an empty upload area. */
  onRemoveFile: () => void;
  /** "Ký tài liệu mới": back to the empty upload area. */
  onSignNewDocument: () => void;
}) {
  const { t } = useTranslation();
  const roundData = round && round !== 'error' ? round : null;

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 rounded-xl border border-border-subtle bg-white px-3 py-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-500">
          <Icon icon="lucide:file-text" className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-text-main" title={review.name}>
            {review.name}
          </div>
          <div className="mt-0.5 text-xs text-text-muted">
            {formatFileSize(file.size)}
            {pageCount ? ` · ${t('upload.pageCount', { count: pageCount })}` : ''}
          </div>
        </div>
        <button
          type="button"
          onClick={onRemoveFile}
          aria-label={t('upload.removeFile')}
          title={t('upload.removeFile')}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-gray-100 hover:text-text-main"
        >
          <Icon icon="lucide:x" className="h-5 w-5" />
        </button>
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface-soft px-3 py-2.5 text-xs">
        <div className="flex items-center justify-between gap-2 pb-1">
          <span className="font-semibold text-text-main">{t('review.title')}</span>
          <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-medium text-green-600">
            <Icon icon="lucide:check-circle-2" className="h-3 w-3" />
            {t('review.signedBadge')}
          </span>
        </div>
        <div className="divide-y divide-border-subtle">
          {roundData?.signer.displayName && (
            <InfoRow label={t('review.signer')}>{roundData.signer.displayName}</InfoRow>
          )}
          {roundData?.authMethod && (
            <InfoRow label={t('review.authMethod')}>{roundData.authMethod}</InfoRow>
          )}
          <InfoRow label={t('review.signedAt')}>
            {roundData?.signedAt || formatLocal(review.signedAt)}
          </InfoRow>
          <InfoRow label={t('done.verificationCodeLabel')}>
            <span className="inline-flex items-center gap-1">
              <code className="break-all font-mono">{review.code}</code>
              <button
                type="button"
                onClick={onCopyCode}
                title={t('done.copyCodeTitle')}
                aria-label={t('done.copyCodeTitle')}
                className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-primary-strong hover:bg-white"
              >
                <Icon icon={codeCopied ? 'lucide:check' : 'lucide:copy'} className="h-3.5 w-3.5" />
              </button>
            </span>
          </InfoRow>
        </div>
        {round === null && (
          <p role="status" className="mt-1.5 flex items-center gap-2 text-text-muted">
            <InlineSpinner />
            {t('verify.loadingResult')}
          </p>
        )}
        {roundData && (
          <button
            type="button"
            onClick={() => onViewDetails(roundData)}
            aria-haspopup="dialog"
            className="mt-1.5 inline-flex items-center gap-1 text-primary-strong hover:underline"
          >
            {t('review.viewDetails')}
            <Icon icon="lucide:maximize-2" className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onDownload}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-primary/90"
        >
          <Icon icon="lucide:download" className="h-4 w-4" />
          {t('review.download')}
        </button>
        <button
          type="button"
          onClick={onContinueSigning}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-primary bg-white px-6 py-2.5 text-sm font-semibold text-primary shadow-sm hover:bg-surface-soft-strong"
        >
          <Icon icon="lucide:pen-line" className="h-4 w-4" />
          {t('review.continueSigning')}
        </button>
        <button
          type="button"
          onClick={onSignNewDocument}
          className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-border-subtle bg-white px-6 py-2.5 text-sm font-semibold text-text-secondary shadow-sm hover:border-primary hover:text-primary"
        >
          <Icon icon="lucide:file-plus" className="h-4 w-4" />
          {t('signStatus.signNewDocument')}
        </button>
      </div>
    </>
  );
}
