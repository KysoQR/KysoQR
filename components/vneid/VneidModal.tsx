'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';

const SIZES = { md: 'max-w-lg', xl: 'max-w-6xl' } as const;

/**
 * The frame of every VNeID popup: a title bar, a body that scrolls, an
 * optional toolbar above it (search) and a footer that always stays in view
 * (the buttons). The page behind does not scroll while it is open, and the
 * popup takes focus so Escape closes it at once.
 *
 * Rendered into document.body: the signer column a popup is opened from is
 * moved with a CSS transform while the page scrolls (StickyAnchorColumn), and
 * a transformed ancestor would box this full-screen overlay into that column,
 * under the wizard's sticky bar.
 */
export function VneidModal({
  title,
  eyebrow,
  subtitle,
  size = 'md',
  onClose,
  closeDisabled = false,
  toolbar,
  footer,
  children,
}: {
  title: ReactNode;
  /** Small line above the title, e.g. "Bước 2/3". */
  eyebrow?: ReactNode;
  subtitle?: ReactNode;
  size?: keyof typeof SIZES;
  onClose: () => void;
  /** While something is being sent: no closing by X or Escape. */
  closeDisabled?: boolean;
  toolbar?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
    const { body } = document;
    const previous = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previous;
    };
  }, []);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 outline-none sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !closeDisabled) onClose();
      }}
    >
      <div
        className={`flex max-h-[92vh] w-full flex-col overflow-hidden rounded-2xl border border-border-subtle bg-white shadow-xl ${SIZES[size]}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4 sm:px-6">
          <div className="min-w-0">
            {eyebrow && (
              <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                {eyebrow}
              </p>
            )}
            <h2 id={titleId} className="text-base font-semibold text-text-main sm:text-lg">
              {title}
            </h2>
            {subtitle && <p className="mt-0.5 text-xs text-text-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            aria-label={t('common.close')}
            className="rounded-full p-1.5 text-text-muted transition hover:bg-surface-soft hover:text-text-main disabled:opacity-60"
          >
            <Icon icon="lucide:x" className="h-5 w-5" />
          </button>
        </div>
        {toolbar && (
          <div className="border-b border-border-subtle bg-surface-soft/60 px-5 py-2.5 sm:px-6">
            {toolbar}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle bg-surface-soft/40 px-5 py-3 sm:px-6">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
