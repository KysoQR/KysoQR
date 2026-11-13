'use client';

import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import { VerificationResultCard } from '@/components/VerificationResultCard';
import type { VerificationResult } from '@/lib/verification/verifyPdfSignatures';

/**
 * Ported from x-sign-web/src/components/signing/SignatureHistorySidebar.tsx,
 * then simplified for the sticky-anchor 3-column layout (`SigningWizard.tsx`):
 * this used to be its own floating, resizable, right-anchored slide-in panel
 * (backdrop, `fixed` positioning, a drag-to-resize handle) that covered the
 * Ký/Đặt lại buttons until closed. It's now a plain 3rd grid column, mounted
 * only while open (`SigningWizard.tsx`'s `showSignatureHistoryColumn`) and
 * anchored/sticky via `StickyAnchorColumn` exactly like the form/PDF columns
 * — so there's nothing left here to make "floating": no backdrop, no
 * `fixed`/`translate-x`, no resize handle/width prop. The header's "Lịch sử
 * ký" toggle (`SigningWizard.tsx`'s `rightSlot`) is the primary way to
 * open/close it; the small close button below (`onClose`) is a convenience
 * for when that toggle has scrolled out of view.
 *
 * Per-signature card content lives in `VerificationResultCard.tsx` (shared
 * with the standalone `/verify` page) — its `STATUS_STYLES` covers this
 * project's full status taxonomy (the legacy version only had
 * SIGNED_VALID/SIGNED_INVALID) since this app deliberately distinguishes e.g.
 * an untrusted root from an outright invalid signature rather than
 * collapsing both into one "invalid" verdict.
 */

interface SignatureHistorySidebarProps {
  onClose: () => void;
  signatures: VerificationResult[];
}

/**
 * The signing wizard's 3rd (rightmost) column, showing every existing
 * digital signature already present in a PDF the user is about to sign
 * (detected via the same verify-upload check the standalone verification
 * page uses). Rendered only when at least one signature was found and the
 * user has the panel open -- the parent doesn't mount this component at all
 * otherwise.
 */
export function SignatureHistorySidebar({ onClose, signatures }: SignatureHistorySidebarProps) {
  const { t } = useTranslation();

  if (signatures.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border-subtle bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between pb-3">
        <p className="text-xs font-semibold text-text-main">
          {t('signatureHistory.subtitle', { count: signatures.length })}
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('signatureHistory.closeAriaLabel')}
          className="rounded-full p-1 text-text-secondary hover:bg-surface-soft hover:text-text-main"
        >
          <Icon icon="lucide:x" className="h-4 w-4" />
        </button>
      </div>
      {/* Each entry used to be its own bordered, rounded box -- stacked with
          6+ signatures, that's a lot of separate outlines in a narrow
          column. `divide-y` gives a single thin separator between entries
          instead, inside this one outer card. */}
      <div className="divide-y divide-border-subtle border-t border-border-subtle">
        {signatures.map((sig, index) => (
          <VerificationResultCard key={index} result={sig} index={index} />
        ))}
      </div>
    </div>
  );
}
