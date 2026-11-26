'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';

/**
 * Shared popup shell for showing a signing-round result in place, without
 * navigating to a separate page -- used by `VerifyDocumentPage.tsx`
 * (lookup-by-code) and `SigningWizard.tsx` ("Xem xác minh" on the Done step,
 * "Xem chi tiết phiên ký" in review mode).
 *
 * Same frame as the certificate popup (`VerificationResultCard.tsx`): a
 * fixed header row with the title and the close button, and only the body
 * scrolls -- the close button used to float over the content's top-right
 * corner (on top of the verdict banner) and scroll away with it.
 * Portaled to <body> so no ancestor's overflow/stacking can clip it; focused
 * on open so Esc works right away; backdrop click also closes.
 *
 * Content-agnostic on purpose: the caller passes whatever it currently has
 * (a loading spinner, an error message, or the real result component) as
 * `children`.
 */
export function VerificationPopup({
  onClose,
  title,
  children,
}: {
  onClose: () => void;
  /** Header text; defaults to "Chi tiết phiên ký". */
  title?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  const heading = title ?? t('signingRound.popupTitle');

  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={heading}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-5 py-3">
          <h2 className="text-sm font-semibold text-text-main">{heading}</h2>
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
        <div className="overflow-y-auto overscroll-contain bg-gray-50/60 px-5 py-5">{children}</div>
      </div>
    </div>,
    document.body
  );
}
