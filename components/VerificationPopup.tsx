'use client';

import { useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';

/**
 * Shared popup shell for showing a verification/signing-round result in
 * place, without navigating to a separate page -- used by both
 * `VerifyDocumentPage.tsx` (lookup-by-code) and
 * `SigningWizard.tsx` ("Xem xác minh" on the Done step). Modeled on
 * `DownloadReminderModal.tsx`'s shell (backdrop, `role="dialog"`,
 * Escape-to-close), plus a visible close button and scrollable content since
 * the content here (`SigningRoundResult`/`VerificationResultPanel`) is
 * usually much taller than that modal's short confirmation copy.
 *
 * Content-agnostic on purpose: the caller passes whatever it currently has
 * (a loading spinner, an error message, or the real result component) as
 * `children` rather than this component owning a loading/error/result state
 * machine itself.
 */
export function VerificationPopup({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose]
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
      onClick={onClose}
    >
      <div
        className="relative max-h-[85vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-border-subtle bg-white p-5 shadow-xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-surface-soft hover:text-text-main"
        >
          <Icon icon="lucide:x" className="h-5 w-5" />
        </button>
        <div className="pt-2">{children}</div>
      </div>
    </div>
  );
}
