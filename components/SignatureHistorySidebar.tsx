'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import { VerificationResultCard } from '@/components/VerificationResultCard';
import { InlineSpinner } from '@/components/signing/Spinners';
import type { VerificationResult } from '@/lib/verification/verifyPdfSignatures';

/**
 * Content of the signing wizard's left pane ("Lịch sử ký"), always shown on
 * the placement step, in 2 sections:
 *
 * 1. Signatures already in the PDF -- detected via the same verify-upload
 *    check the standalone /verify page uses (a spinner while it runs, an
 *    empty note when there are none).
 * 2. The signature boxes the user has placed on this file so far -- click
 *    one to scroll the PDF to it, X to remove it.
 *
 * Originally ported from x-sign-web's SignatureHistorySidebar (a floating,
 * toggleable slide-in panel); the toggle and close button are gone now that
 * the pane is a fixed part of the layout.
 *
 * Per-signature card content lives in `VerificationResultCard.tsx`: it only
 * shows "Hợp lệ"/"Không hợp lệ"; the specific reason (from the full status
 * taxonomy, e.g. an untrusted root vs. a modified document) is in its
 * "Thông tin chứng thư số" popup.
 */

export interface PlacedFieldItem {
  /** Index into the wizard's `signatureFields`. */
  index: number;
  /** Number shown on the box ("Chữ ký #n"), see `fieldOrdinals`. */
  ordinal: number;
  page: number;
}

interface SignatureHistorySidebarProps {
  signatures: VerificationResult[];
  checking: boolean;
  fields: PlacedFieldItem[];
  onFocusField: (index: number) => void;
  onRemoveField: (index: number) => void;
  /** False in review mode (an already-signed round reopened from the home
   * page): nothing can be placed there, so the section is hidden. */
  showNewFields?: boolean;
  /** True once "Ký" was pressed: boxes can only be focused, not removed. */
  readOnly?: boolean;
}

function SectionTitle({ children, count }: { children: ReactNode; count: number }) {
  return (
    <h4 className="flex items-center gap-1.5 text-xs font-semibold text-text-main">
      {children}
      <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary-strong">
        {count}
      </span>
    </h4>
  );
}

export function SignatureHistorySidebar({
  signatures,
  checking,
  fields,
  onFocusField,
  onRemoveField,
  showNewFields = true,
  readOnly = false,
}: SignatureHistorySidebarProps) {
  const { t } = useTranslation();

  // When a box is added, bring "Vị trí ký vừa thêm" into view -- with many
  // existing signatures it sits far below the fold. Only inside the pane's
  // own scroll container (wide screens, `overflow-y: auto`); on phones the
  // whole page scrolls and jumping it down to this pane would pull the user
  // away from the PDF, so nothing happens there.
  const newFieldsRef = useRef<HTMLElement | null>(null);
  const prevFieldCountRef = useRef(fields.length);
  useEffect(() => {
    const grew = fields.length > prevFieldCountRef.current;
    prevFieldCountRef.current = fields.length;
    const section = newFieldsRef.current;
    if (!grew || !section) return;
    let container = section.parentElement;
    while (container && getComputedStyle(container).overflowY !== 'auto') {
      container = container.parentElement;
    }
    if (!container || container.scrollHeight <= container.clientHeight) return;
    // Scroll far enough to also show the pane's own bottom padding, so the
    // last item keeps its breathing room instead of sitting on the edge.
    const sectionBottom =
      section.getBoundingClientRect().bottom - container.getBoundingClientRect().top;
    const paddingBottom = parseFloat(getComputedStyle(container).paddingBottom) || 0;
    const overflow = sectionBottom + paddingBottom - container.clientHeight;
    if (overflow > 0) {
      container.scrollTo({ top: container.scrollTop + overflow, behavior: 'smooth' });
    }
  }, [fields.length]);

  return (
    <div className="flex flex-col gap-5">
      <section>
        <SectionTitle count={signatures.length}>
          {t('signatureHistory.existingTitle')}
        </SectionTitle>
        {checking ? (
          <p role="status" className="mt-2 flex items-center gap-2 text-xs text-text-muted">
            <InlineSpinner />
            {t('sign.checkingSignatures')}
          </p>
        ) : signatures.length === 0 ? (
          <p className="mt-2 text-xs text-text-muted">{t('signatureHistory.existingEmpty')}</p>
        ) : (
          // One thin separator between entries instead of a bordered box
          // per signature -- fewer outlines in a narrow column.
          <div className="mt-2 divide-y divide-border-subtle border-t border-border-subtle">
            {signatures.map((sig, index) => (
              <VerificationResultCard key={index} result={sig} index={index} />
            ))}
          </div>
        )}
      </section>

      {/* pb-3 (+ the pane's own p-3): breathing room under the last item
          instead of it sitting right on the pane's bottom edge. */}
      {showNewFields && (
      <section ref={newFieldsRef} className="border-t border-border-subtle pb-3 pt-4">
        <SectionTitle count={fields.length}>{t('signatureHistory.newFieldsTitle')}</SectionTitle>
        {fields.length === 0 ? (
          <p className="mt-2 text-xs text-text-muted">{t('signatureHistory.newFieldsEmpty')}</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {fields.map((field) => (
              <li
                key={field.index}
                className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-soft pr-1 transition-colors hover:border-primary"
              >
                <button
                  type="button"
                  onClick={() => onFocusField(field.index)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left"
                >
                  <Icon icon="lucide:pen-line" className="h-4 w-4 shrink-0 text-primary-strong" />
                  <span className="truncate text-xs font-semibold text-text-main">
                    {t('sign.fieldLabel', { n: field.ordinal })}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-text-muted">
                    {t('common.page')} {field.page}
                  </span>
                </button>
                {!readOnly && (
                <button
                  type="button"
                  onClick={() => onRemoveField(field.index)}
                  aria-label={t('sign.removeField')}
                  title={t('sign.removeField')}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-white hover:text-red-600"
                >
                  <Icon icon="lucide:x" className="h-4 w-4" />
                </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      )}
    </div>
  );
}
