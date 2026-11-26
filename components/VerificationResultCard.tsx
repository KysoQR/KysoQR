'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import type { ChainCertInfo } from '@/lib/verification/certChainVerifier';
import type { RevocationCheckResult } from '@/lib/verification/revocationChecker';
import type { VerificationResult } from '@/lib/verification/verifyPdfSignatures';

/**
 * One signature's verification outcome — status chip, signed-by/signed-at,
 * content-integrity line, and a button opening the certificate-chain detail
 * in a popup (it used to expand inline, which was cramped in the narrow
 * history pane and pushed everything below it down). Extracted out of
 * `SignatureHistorySidebar.tsx`, where it is rendered.
 */

/**
 * Popup for the certificate detail -- same look as the app's other modals
 * (SignRequestErrorModal). Portaled to <body> so the history pane's
 * `overflow-hidden` frame can't clip it. Closes on Esc, backdrop click, or X.
 */
function CertificateDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Focus on open so Esc works right away.
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
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl border border-border-subtle bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-5 py-3">
          <h2 className="text-sm font-semibold text-text-main">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
            className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-gray-100 hover:text-text-main"
          >
            <Icon icon="lucide:x" className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4 text-xs text-text-secondary">{children}</div>
      </div>
    </div>,
    document.body
  );
}

function formatValidity(from: string | undefined, to: string | undefined): string | null {
  if (!from && !to) return null;
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  };
  return `${from ? fmt(from) : '?'} — ${to ? fmt(to) : '?'}`;
}

/** Best-effort "CN=" extraction from a formatted DN string (e.g.
 * "C=VN, O=..., CN=Nguyễn Văn A") for a friendlier "signed by" line. */
function extractCommonName(dn: string | undefined): string | undefined {
  if (!dn) return undefined;
  const match = /(?:^|,\s*)CN=([^,]+)/.exec(dn);
  return match?.[1]?.trim();
}

function formatSignedAt(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString();
}

/**
 * One OCSP or CRL line for a chain entry. `result === null` means this cert
 * was never checked (the root); otherwise the check ran but may still have
 * found no URL at all (e.g. no AIA/CRL entry) or failed live (network error,
 * bad signature) -- both degrade to the same "unsupported" text unless a URL
 * is at least known, in which case it's shown alongside "couldn't check".
 */
function RevocationLine({
  label,
  result,
}: {
  label: string;
  result: RevocationCheckResult | null;
}) {
  const { t } = useTranslation();

  if (!result || (result.status === 'unavailable' && !result.url)) {
    return (
      <div>
        <span className="text-text-muted">{label}: </span>
        {t('signatureHistory.chain.revocationUnsupported')}
      </div>
    );
  }

  if (result.status === 'unavailable') {
    return (
      <div>
        <span className="text-text-muted">{label}: </span>
        {t('signatureHistory.chain.revocation.unavailableWithUrl')} [{result.url}]
      </div>
    );
  }

  return (
    <div>
      <span className="text-text-muted">{label}: </span>
      <span className={result.status === 'revoked' ? 'font-medium text-red-600' : undefined}>
        {t(
          result.status === 'revoked'
            ? 'signatureHistory.chain.revocation.revoked'
            : 'signatureHistory.chain.revocation.notRevoked'
        )}
      </span>{' '}
      [{result.url}]
    </div>
  );
}

/**
 * One block per certificate in the chain -- but only the leaf (signer) and
 * its direct issuer, not every ancestor up to the root. The real
 * verification (certChainVerifier.ts) still walks and cryptographically
 * checks the full path all the way to a trusted root -- that doesn't change
 * here, only what's displayed does. Showing the root CA's own card was
 * confusing rather than informative: a root is self-signed, so its
 * "Chủ thể"/"Tổ chức phát hành" lines are always identical, which read as a
 * duplicated/redundant block to someone not already familiar with that PKI
 * convention. Explicit product decision: trim the display to leaf + direct
 * issuer, drop the rest silently.
 */
function CertificateChainDetail({ chain }: { chain: ChainCertInfo[] }) {
  const { t } = useTranslation();
  if (chain.length === 0) return null;
  const displayedChain = chain.slice(0, 2);

  return (
    <div className="mt-2.5 space-y-2.5">
      {displayedChain.map((cert) => (
        <div
          key={cert.index}
          className="rounded-lg border border-border-subtle bg-white p-2.5 text-xs"
        >
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="font-semibold text-text-main">
              {cert.isCa ? t('signatureHistory.chain.ca') : t('signatureHistory.chain.leaf')}
            </span>
            <span className="rounded-full bg-surface-soft px-2 py-0.5 text-[10px] font-medium text-text-secondary">
              #{cert.index}
            </span>
          </div>
          <div className="space-y-1 text-text-secondary">
            <div>
              <span className="text-text-muted">{t('verify.subject')}: </span>
              <span className="break-all">{cert.subject}</span>
            </div>
            <div>
              <span className="text-text-muted">{t('verify.issuer')}: </span>
              <span className="break-all">{cert.issuer}</span>
            </div>
            <div>
              <span className="text-text-muted">{t('signatureHistory.chain.serial')}: </span>
              <span className="break-all">{cert.serialNumber}</span>
            </div>
            {formatValidity(cert.validFrom, cert.validTo) && (
              <div>
                <span className="text-text-muted">{t('signatureHistory.chain.validity')}: </span>
                {formatValidity(cert.validFrom, cert.validTo)}
              </div>
            )}
            <RevocationLine label="OCSP" result={cert.ocsp} />
            <RevocationLine label="CRL" result={cert.crl} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Only 2 outcomes are shown on the card: "Hợp lệ" (green) or "Không hợp
 * lệ" (red) -- per explicit request; the specific reason (e.g. "Root CA
 * chưa được tin cậy") moved into the certificate popup.
 */
const VALID_CHIP = { chip: 'bg-green-100 text-green-600', icon: 'lucide:check-circle-2' };
const INVALID_CHIP = { chip: 'bg-red-100 text-red-600', icon: 'lucide:x-circle' };

export function VerificationResultCard({
  result,
  index,
}: {
  result: VerificationResult;
  index: number;
}) {
  const { t } = useTranslation();
  const isValid = result.status === 'SIGNED_VALID';
  const style = isValid ? VALID_CHIP : INVALID_CHIP;
  const signatureLabel = t('verify.signatureNumber', { number: result.position ?? index + 1 });
  const signedAt = formatSignedAt(result.signedAt);
  const signedByName = extractCommonName(result.certificate?.subject);

  const hasChain = Boolean(result.certificateChain && result.certificateChain.length > 0);
  const hasPlainCertificate = Boolean(result.certificate?.subject || result.certificate?.issuer);
  const [open, setOpen] = useState(false);

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-text-main">{signatureLabel}</span>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.chip}`}
        >
          <Icon icon={style.icon} className="h-3 w-3" />
          {isValid ? t('verify.shortLabels.SIGNED_VALID') : t('signatureHistory.invalid')}
        </span>
      </div>

      {signedByName && (
        <div className="mt-2 text-xs text-text-secondary">
          <span className="text-text-muted">{t('verify.signedBy')}: </span>
          {signedByName}
        </div>
      )}

      {signedAt && (
        <div className="mt-0.5 text-xs text-text-secondary">
          <span className="text-text-muted">{t('verify.signedAt')}: </span>
          {signedAt}
        </div>
      )}

      {result.contentIntact !== undefined && (
        <div className="mt-2 text-xs text-text-secondary">
          <span className="text-text-muted">{t('signatureHistory.chain.documentIntegrity')}: </span>
          {result.contentIntact
            ? t('signingRound.tiles.integrityHintOk')
            : t('signingRound.tiles.integrityHintBad')}
        </div>
      )}

      {/* Also shown for an invalid signature without any certificate info
          (e.g. an unsupported format), so its reason is still reachable. */}
      {(hasChain || hasPlainCertificate || !isValid) && (
        <div className="mt-2 text-xs">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            className="inline-flex select-none items-center gap-1 text-primary-strong hover:underline"
          >
            {t('signatureHistory.certInfo')}
            <Icon icon="lucide:maximize-2" className="h-3 w-3" />
          </button>
        </div>
      )}

      {open && (
        <CertificateDialog
          title={`${t('signatureHistory.certInfo')} · ${signatureLabel}`}
          onClose={() => setOpen(false)}
        >
          {!isValid && (
            <div className="mb-4 rounded-lg border border-error-border bg-error-bg px-3 py-2.5 text-error-text">
              <p className="flex items-center gap-1.5 text-xs font-semibold">
                <Icon icon="lucide:x-circle" className="h-4 w-4 shrink-0" />
                {t('signatureHistory.reasonTitle')}: {t(`verify.shortLabels.${result.status}`)}
              </p>
              <p className="mt-1 text-xs">{t(`signatureHistory.reasons.${result.status}`)}</p>
              {result.message && (
                <p className="mt-1.5 break-words text-[11px] text-text-muted">
                  {t('signatureHistory.technicalDetail')}: {result.message}
                </p>
              )}
            </div>
          )}
          {hasChain ? (
            <CertificateChainDetail chain={result.certificateChain!} />
          ) : (
            hasPlainCertificate && (
              <div className="space-y-1">
                {result.certificate?.subject && (
                  <div>
                    <span className="text-text-muted">{t('verify.subject')}: </span>
                    <span className="break-all">{result.certificate.subject}</span>
                  </div>
                )}
                {result.certificate?.issuer && (
                  <div>
                    <span className="text-text-muted">{t('verify.issuer')}: </span>
                    <span className="break-all">{result.certificate.issuer}</span>
                  </div>
                )}
              </div>
            )
          )}
        </CertificateDialog>
      )}
    </div>
  );
}
