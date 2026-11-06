'use client';

import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import { VerificationResultCard } from '@/components/VerificationResultCard';
import type { VerificationResult } from '@/lib/verification/verifyPdfSignatures';

const DARK_SIDEBAR_VARS: CSSProperties = {
  '--color-text-main': '#f3f4f6',
  '--color-text-secondary': '#d1d5db',
  '--color-text-muted': '#9ca3af',
  '--color-primary-strong': '#34d399',
  '--color-border-subtle': '#3f4448',
  '--color-surface-soft': '#24282c',
} as CSSProperties;

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
    <div
      style={DARK_SIDEBAR_VARS}
      className="min-h-full border-r border-[#33373b] bg-[#222528] p-4 text-gray-100"
    >
      <div className="mb-3 flex items-start justify-between border-b border-[#33373b] pb-3">
        <div>
          <h3 className="text-sm font-bold text-white">
            {t('verify.title')}
          </h3>
          <p className="mt-0.5 text-xs text-gray-400">
            {t('signatureHistory.subtitle', { count: signatures.length })}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('signatureHistory.closeAriaLabel')}
          className="rounded-full p-1 text-gray-400 hover:bg-[#33373b] hover:text-white"
        >
          <Icon icon="lucide:x" className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-3">
        {signatures.map((sig, index) => (
          <div
            key={index}
            className="rounded-xl border border-[#3e4348] bg-[#2d3135] px-3.5 py-0.5"
          >
            <VerificationResultCard result={sig} index={index} />
          </div>
        ))}
      </div>
    </div>
  );
}
