'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import type { ChainCertInfo } from '@/lib/verification/certChainVerifier';
import type { RevocationCheckResult } from '@/lib/verification/revocationChecker';
import type {
  VerificationResult,
  VerificationStatus,
} from '@/lib/verification/verifyPdfSignatures';

/**
 * One signature's verification outcome — status chip, signed-by/signed-at,
 * content-integrity line, expandable certificate-chain detail. Extracted out
 * of `SignatureHistorySidebar.tsx` (where it originated) so both the sidebar
 * and the standalone `/verify` page render it identically.
 */

function formatValidity(from: string | undefined, to: string | undefined): string | null {
  if (!from && !to) return null;
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  };
  return `${from ? fmt(from) : '?'} — ${to ? fmt(to) : '?'}`;
}

/** Best-effort "CN=" extraction from a formatted DN string (e.g.
 * "C=VN, O=..., CN=Nguyễn Đức Duy") for a friendlier "signed by" line. */
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

export const STATUS_STYLES: Record<
  VerificationStatus,
  { chip: string; icon: string; labelKey: string }
> = {
  SIGNED_VALID: {
    chip: 'bg-green-100 text-green-600',
    icon: 'lucide:check-circle-2',
    labelKey: 'verify.shortLabels.SIGNED_VALID',
  },
  ROOT_NOT_TRUSTED: {
    chip: 'bg-amber-100 text-amber-700',
    icon: 'lucide:shield-alert',
    labelKey: 'verify.shortLabels.ROOT_NOT_TRUSTED',
  },
  CONTENT_DIGEST_MISMATCH: {
    chip: 'bg-red-100 text-red-600',
    icon: 'lucide:file-warning',
    labelKey: 'verify.shortLabels.CONTENT_DIGEST_MISMATCH',
  },
  CHAIN_VALIDATION_FAILED: {
    chip: 'bg-red-100 text-red-600',
    icon: 'lucide:link-2-off',
    labelKey: 'verify.shortLabels.CHAIN_VALIDATION_FAILED',
  },
  SIGNATURE_INVALID: {
    chip: 'bg-red-100 text-red-600',
    icon: 'lucide:alert-triangle',
    labelKey: 'verify.shortLabels.SIGNATURE_INVALID',
  },
  TRUST_STORE_NOT_CONFIGURED: {
    chip: 'bg-gray-100 text-gray-600',
    icon: 'lucide:server-off',
    labelKey: 'verify.shortLabels.TRUST_STORE_NOT_CONFIGURED',
  },
  UNSUPPORTED_SUBFILTER: {
    chip: 'bg-gray-100 text-gray-600',
    icon: 'lucide:file-question',
    labelKey: 'verify.shortLabels.UNSUPPORTED_SUBFILTER',
  },
  UNSUPPORTED_ALGORITHM: {
    chip: 'bg-gray-100 text-gray-600',
    icon: 'lucide:file-question',
    labelKey: 'verify.shortLabels.UNSUPPORTED_ALGORITHM',
  },
};

export function VerificationResultCard({
  result,
  index,
}: {
  result: VerificationResult;
  index: number;
}) {
  const { t } = useTranslation();
  const style = STATUS_STYLES[result.status];
  const signedAt = formatSignedAt(result.signedAt);
  const signedByName = extractCommonName(result.certificate?.subject);

  const hasChain = Boolean(result.certificateChain && result.certificateChain.length > 0);
  const hasPlainCertificate = Boolean(result.certificate?.subject || result.certificate?.issuer);
  const [open, setOpen] = useState(false);

  return (
    <div className="py-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-text-main">
          {t('verify.signatureNumber', { number: result.position ?? index + 1 })}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.chip}`}
        >
          <Icon icon={style.icon} className="h-3 w-3" />
          {t(style.labelKey)}
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

      {hasChain ? (
        <div className="mt-2 text-xs text-text-secondary">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex select-none items-center gap-1 text-primary-strong"
          >
            {t('signatureHistory.chain.title')}
            <span className={`text-gray-400 transition ${open ? 'rotate-180' : ''}`}>▾</span>
          </button>
          {open && (
            <>
              <CertificateChainDetail chain={result.certificateChain!} />
              {result.certificateChainRootNotInTrustStore && (
                <div className="mt-1.5 rounded-md bg-error-bg px-2 py-1 text-[11px] text-error-text">
                  {t('signatureHistory.chain.rootNotTrusted')}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        hasPlainCertificate && (
          <div className="mt-2 text-xs text-text-secondary">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="flex select-none items-center gap-1 text-primary-strong"
            >
              {t('verify.certificate')}
              <span className={`text-gray-400 transition ${open ? 'rotate-180' : ''}`}>▾</span>
            </button>
            {open && (
              <div className="mt-1.5 space-y-1 pl-1">
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
            )}
          </div>
        )
      )}
    </div>
  );
}
