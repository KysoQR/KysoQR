'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import QR from '@/components/QR';
import { QRErrorBoundary } from '@/components/signing/QRErrorBoundary';
import { ExpiresIn } from '@/components/signing/ExpiresIn';

/** Cas ID's guide for getting a personal digital certificate (Cas Cert). */
export const CAS_CERT_GUIDE_URL = 'https://casid.vn/chu-ky-so/ca-nhan/';

/**
 * The "Quét QR bằng Cas ID" popup, shown over the 3-pane workspace right
 * after "Ký" -- replaces the old full-page scan step. Closing it does not
 * cancel anything: the wizard stays on the (locked) workspace, keeps polling,
 * and the right pane offers "Mở lại mã QR". Same frame as the app's other
 * popups (title row + X, Esc / backdrop click closes).
 */
export function QrSignDialog({
  qrContent,
  expiresAt,
  onExpired,
  status,
  statusError,
  onSyncStatus,
  onCopyLink,
  linkCopied,
  onClose,
}: {
  qrContent: string | null;
  expiresAt: string | null;
  onExpired: () => void;
  status: string | null;
  statusError: string | null;
  onSyncStatus: () => void;
  onCopyLink: () => void;
  linkCopied: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
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
      aria-label={t('scan.dialogTitle')}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-5 py-3">
          <h2 className="text-sm font-semibold text-text-main">{t('scan.dialogTitle')}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-gray-100 hover:text-text-main"
          >
            <Icon icon="lucide:x" className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-col items-center overflow-y-auto overscroll-contain px-5 py-5 text-center">
          <p className="text-sm text-text-secondary">{t('scan.instruction')}</p>

          <div className="mt-4 rounded-xl border border-border-subtle bg-white p-3 shadow-sm">
            {qrContent ? (
              <QRErrorBoundary
                fallback={
                  <div className="max-w-[220px] text-sm text-red-600">
                    {t('scan.qrRenderFailed')} {t('scan.qrRenderFailedSeePayload')}
                  </div>
                }
              >
                <QR value={qrContent} size={220} level="H" logoSrc="/cas-id-logo.webp" />
              </QRErrorBoundary>
            ) : (
              <div className="flex h-[220px] w-[220px] items-center justify-center text-xs text-text-muted">
                {t('scan.qrUnavailable')}
              </div>
            )}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1.5 text-text-muted">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
              {status === 'ACCEPTED' ? t('scan.accepted') : t('scan.waiting')}
            </span>
          </div>
          <div className="mt-0.5">
            <ExpiresIn expiresAt={expiresAt} onExpired={onExpired} />
          </div>

          {statusError && (
            <div className="mt-3 w-full rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-left text-xs text-warning-text">
              {t('scan.statusError')} <span className="font-mono">{statusError}</span>
            </div>
          )}

          {qrContent && (
            <div className="mt-4 flex w-full items-center gap-2">
              <div
                className="min-w-0 flex-1 truncate rounded-md bg-gray-50 px-3 py-2 text-left text-xs text-text-main"
                title={qrContent}
              >
                <span className="text-text-muted">{t('scan.linkLabel')} </span>
                {qrContent}
              </div>
              <button
                type="button"
                onClick={onCopyLink}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border-subtle bg-white px-3 py-1.5 text-xs font-medium text-text-secondary transition hover:border-primary hover:text-primary"
              >
                <Icon icon={linkCopied ? 'lucide:check' : 'lucide:copy'} className="h-3.5 w-3.5" />
                {linkCopied ? t('scan.copied') : t('scan.copyLink')}
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={onSyncStatus}
            className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-primary bg-white px-3.5 py-1.5 text-xs font-semibold text-primary transition hover:bg-surface-soft"
          >
            <Icon icon="lucide:refresh-cw" className="h-3.5 w-3.5" />
            {t('scan.syncStatus')}
          </button>

          {/* For a signer who doesn't have a certificate yet. */}
          <div className="mt-5 flex w-full items-start gap-2 rounded-xl border border-border-subtle bg-surface-soft px-3 py-2.5 text-left text-xs text-text-secondary">
            <Icon icon="lucide:info" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary-strong" />
            <p>
              {t('scan.casCertHint')}{' '}
              <a
                href={CAS_CERT_GUIDE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 font-semibold text-primary-strong hover:underline"
              >
                {t('scan.casCertLink')}
                <Icon icon="lucide:external-link" className="h-3 w-3" />
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
