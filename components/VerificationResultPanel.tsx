'use client';

import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import { SigningCard } from '@/components/signing/SigningCard';
import type { ChainCertInfo } from '@/lib/verification/certChainVerifier';
import type { VerificationResult, VerificationStatus } from '@/lib/verification/verifyPdfSignatures';

/**
 * Adapted from x-sign-web's original `VerifyPage.tsx` `VerificationResult`
 * function (deleted upstream in commit 316d224, restored here from
 * `git show 2c9b1e2:src/features/verification/VerifyPage.tsx`): status
 * banner with colored border/chip/icon, signature info, expandable
 * certificate detail with copy-to-clipboard, and a certificate-chain
 * timeline.
 *
 * Adapted (not a literal copy) for this project's 7-value status taxonomy
 * (the original had 5: SIGNED_VALID/SIGNED_INVALID/PENDING/EXPIRED/NOT_FOUND)
 * and for fields our `VerificationResult` doesn't carry (no DB-backed
 * `document`/`keyUsage`/`technical_reason` here — this app verifies
 * cryptographically from the uploaded file alone, nothing stored). Crucially,
 * unlike the original (which the commit's own comment says "no longer
 * surfaces root-not-trusted as a warning -- backend already classifies it as
 * SIGNED_VALID"), `ROOT_NOT_TRUSTED` here is always shown as its own distinct,
 * non-green status -- that silent downgrade was the exact vulnerability this
 * whole rewrite exists to fix.
 */

const STATUS_META: Record<
  VerificationStatus,
  { color: string; bg: string; subColor: string; border: string; chip: string; icon: string }
> = {
  SIGNED_VALID: {
    color: 'text-green-500',
    bg: 'bg-green-500',
    subColor: 'text-green-700',
    border: 'border-l-[5px] border-green-500',
    chip: 'bg-green-100 text-green-500',
    icon: 'lucide:check',
  },
  ROOT_NOT_TRUSTED: {
    color: 'text-amber-500',
    bg: 'bg-amber-500',
    subColor: 'text-amber-700',
    border: 'border-l-[5px] border-amber-500',
    chip: 'bg-amber-100 text-amber-600',
    icon: 'lucide:shield-alert',
  },
  CONTENT_DIGEST_MISMATCH: {
    color: 'text-red-500',
    bg: 'bg-red-500',
    subColor: 'text-red-700',
    border: 'border-l-[5px] border-red-500',
    chip: 'bg-red-100 text-red-500',
    icon: 'lucide:file-warning',
  },
  CHAIN_VALIDATION_FAILED: {
    color: 'text-red-500',
    bg: 'bg-red-500',
    subColor: 'text-red-700',
    border: 'border-l-[5px] border-red-500',
    chip: 'bg-red-100 text-red-500',
    icon: 'lucide:link-2-off',
  },
  SIGNATURE_INVALID: {
    color: 'text-red-500',
    bg: 'bg-red-500',
    subColor: 'text-red-700',
    border: 'border-l-[5px] border-red-500',
    chip: 'bg-red-100 text-red-500',
    icon: 'lucide:alert-triangle',
  },
  TRUST_STORE_NOT_CONFIGURED: {
    color: 'text-gray-500',
    bg: 'bg-gray-500',
    subColor: 'text-gray-700',
    border: 'border-l-[5px] border-gray-500',
    chip: 'bg-gray-100 text-gray-500',
    icon: 'lucide:server-off',
  },
  UNSUPPORTED_SUBFILTER: {
    color: 'text-gray-500',
    bg: 'bg-gray-500',
    subColor: 'text-gray-700',
    border: 'border-l-[5px] border-gray-500',
    chip: 'bg-gray-100 text-gray-500',
    icon: 'lucide:file-question',
  },
  UNSUPPORTED_ALGORITHM: {
    color: 'text-gray-500',
    bg: 'bg-gray-500',
    subColor: 'text-gray-700',
    border: 'border-l-[5px] border-gray-500',
    chip: 'bg-gray-100 text-gray-500',
    icon: 'lucide:file-question',
  },
};

/** Best-effort "CN=" extraction from a formatted DN string for a friendlier "signed by" line. */
function extractCommonName(dn: string | undefined): string | undefined {
  if (!dn) return undefined;
  const match = /(?:^|,\s*)CN=([^,]+)/.exec(dn);
  return match?.[1]?.trim();
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function CopyIcon({ value }: { value: string }) {
  return (
    <Icon
      icon="lucide:copy"
      className="mt-1 h-4 w-4 shrink-0 cursor-pointer text-primary-strong"
      onClick={() => {
        navigator.clipboard.writeText(value).catch(() => {
          // Clipboard may be unavailable; fail silently.
        });
      }}
    />
  );
}

function CertificateChainTimeline({
  chain,
  signedByName,
}: {
  chain: ChainCertInfo[];
  signedByName: string | undefined;
}) {
  const { t } = useTranslation();
  const reversed = [...chain].reverse();

  return (
    <ol className="relative ml-3 mt-5 space-y-5 border-l border-gray-200">
      {reversed.map((c, idx, arr) => {
        const isRoot = idx === 0;
        const isLeaf = idx === arr.length - 1;
        const label = isLeaf ? t('verify.leafCert') : isRoot && c.isCa ? t('verify.rootCaCert') : t('verify.caCert');

        return (
          <li key={c.index} className="relative ml-6">
            <span
              className={`absolute -left-9 top-6 flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-white ${
                isLeaf ? 'bg-primary-strong' : 'bg-gray-100'
              }`}
            >
              <Icon
                icon={isLeaf ? 'lucide:user' : 'lucide:shield-check'}
                className={`h-4 w-4 ${isLeaf ? 'text-white' : 'text-gray-500'}`}
              />
            </span>

            <details className="group rounded-xl border transition open:shadow-sm">
              <summary
                className={`cursor-pointer list-none rounded-xl p-4 outline-none transition focus-visible:ring-2 focus-visible:ring-primary ${
                  isLeaf ? 'border-primary-strong bg-green-50' : 'border-gray-200 bg-gray-50'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className={`text-xs font-semibold ${isLeaf ? 'text-primary' : 'text-gray-800'}`}>
                      {label} #{c.index}
                    </div>
                    <div className="mt-2 text-sm font-medium text-gray-900">
                      {isLeaf && signedByName ? signedByName : c.subject}
                    </div>
                  </div>
                  <span className="mt-1 text-gray-400 transition group-open:rotate-180">▾</span>
                </div>
              </summary>

              <div
                className={`-mt-2 rounded-b-xl px-4 pb-4 pt-3 ${isLeaf ? 'bg-green-50' : 'border-gray-200 bg-gray-50'}`}
              >
                <div className="grid grid-cols-1 gap-3 text-xs text-gray-600 sm:grid-cols-2">
                  <div>
                    <div className="text-gray-400">{t('verify.subject')}</div>
                    <div className="mt-1 break-all font-mono text-gray-900">{c.subject}</div>
                  </div>
                  <div>
                    <div className="text-gray-400">{t('verify.issuer')}</div>
                    <div className="mt-1 break-all font-mono text-gray-900">{c.issuer}</div>
                  </div>
                  <div>
                    <div className="text-gray-400">{t('verify.serial')}</div>
                    <div className="mt-1 break-all font-mono text-gray-900">{c.serialNumber}</div>
                  </div>
                  <div>
                    <div className="text-gray-400">{t('verify.valid')}</div>
                    <div className="mt-1 font-mono text-gray-900">
                      {formatDate(c.validFrom)} → {formatDate(c.validTo)}
                    </div>
                  </div>
                  <div>
                    <div className="text-gray-400">CA</div>
                    <div className="mt-1 text-gray-900">{c.isCa ? 'Yes' : 'No'}</div>
                  </div>
                </div>
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

export function VerificationResultPanel({ result }: { result: VerificationResult }) {
  const { t } = useTranslation();
  const meta = STATUS_META[result.status];
  const signedByName = extractCommonName(result.certificate?.subject);
  const chainKnown = result.status === 'SIGNED_VALID' || result.status === 'ROOT_NOT_TRUSTED' || result.status === 'CHAIN_VALIDATION_FAILED';
  const chainValid = result.status === 'SIGNED_VALID' || result.status === 'ROOT_NOT_TRUSTED';
  const statusLabel = t(`verify.shortLabels.${result.status}`);

  return (
    <div className="space-y-4">
      <SigningCard className={meta.border}>
        <div className="flex items-start justify-between">
          <div>
            <div className="text-sm font-medium text-gray-400">{t('verify.status')}</div>
            <div className="mt-1 flex items-center gap-2">
              <span className={`text-md font-medium ${meta.color}`}>{statusLabel}</span>
            </div>
          </div>
          <div className="flex flex-col items-end justify-end">
            <span
              className={`mb-2 inline-flex h-7 w-fit min-w-[90px] items-center justify-center whitespace-nowrap rounded-full px-4 text-xs font-semibold ${meta.chip}`}
            >
              {statusLabel.toLocaleUpperCase()}
            </span>
            <div
              className={`flex h-6 w-6 items-center justify-center rounded-full ${meta.bg} text-white`}
              aria-hidden="true"
            >
              <Icon icon={meta.icon} className="h-3.5 w-3.5" />
            </div>
          </div>
        </div>
        <div>
          {result.message && <div className={`text-sm font-medium ${meta.subColor}`}>{result.message}</div>}
          {result.contentIntact === true && (
            <div className={`mt-2 text-xs underline ${meta.subColor}`}>{t('verify.contentIntact.ok')}</div>
          )}
          {result.contentIntact === false && (
            <div className="mt-2 text-xs text-red-700">{t('verify.contentIntact.modified')}</div>
          )}
          {result.contentIntact === undefined && (
            <div className="mt-2 text-xs text-gray-600">{t('verify.contentIntact.unknown')}</div>
          )}
        </div>
      </SigningCard>

      {(result.signedAt || signedByName) && (
        <SigningCard>
          <div className="mb-2 text-sm font-medium text-gray-400">{t('verify.signature')}</div>
          <div className="mt-1 flex flex-col gap-1 text-sm">
            {result.signedAt && (
              <div className="flex flex-row items-center gap-2">
                <Icon icon="lucide:clock" className="inline-block h-4 w-4 text-gray-500" />
                <span className="text-sm text-gray-500">{t('verify.signedAt')}:</span>
                <span className="text-gray-500">{formatDate(result.signedAt)}</span>
              </div>
            )}
            {signedByName && (
              <div className="flex flex-row items-center gap-2">
                <Icon icon="lucide:user" className="inline-block h-4 w-4 text-gray-500" />
                <span className="text-sm text-gray-500">{t('verify.signedBy')}:</span>
                <span className="text-sm font-medium text-primary-strong">{signedByName}</span>
              </div>
            )}
          </div>
        </SigningCard>
      )}

      {result.certificate && (
        <SigningCard>
          <details className="group" open>
            <summary className="flex cursor-pointer items-center justify-between text-sm text-gray-500">
              <span className="text-sm font-medium text-gray-400">{t('verify.certificate')}</span>
              <span className="ml-2 text-gray-400 transition group-open:rotate-180">▾</span>
            </summary>
            <div className="mt-3 divide-y divide-gray-200 text-sm">
              <div className="flex flex-col gap-2 py-3 sm:grid sm:grid-cols-[150px_1fr] sm:gap-4">
                <div className="text-gray-500">{t('verify.subject')}</div>
                <div className="flex items-start gap-2">
                  <div className="flex-1 break-all font-mono">{result.certificate.subject}</div>
                  <CopyIcon value={result.certificate.subject} />
                </div>
              </div>
              <div className="flex flex-col gap-2 py-3 sm:grid sm:grid-cols-[150px_1fr] sm:gap-4">
                <div className="text-gray-500">{t('verify.issuer')}</div>
                <div className="flex items-start gap-2">
                  <div className="flex-1 break-all font-mono">{result.certificate.issuer}</div>
                  <CopyIcon value={result.certificate.issuer} />
                </div>
              </div>
              <div className="flex flex-col gap-2 py-3 sm:grid sm:grid-cols-[150px_1fr] sm:gap-4">
                <div className="text-gray-500">{t('verify.serial')}</div>
                <div className="flex items-start gap-2">
                  <div className="flex-1 break-all font-mono">{result.certificate.serialNumber}</div>
                  <CopyIcon value={result.certificate.serialNumber} />
                </div>
              </div>
              <div className="flex flex-col gap-2 py-3 sm:grid sm:grid-cols-[150px_1fr] sm:gap-4">
                <div className="text-gray-500">{t('verify.valid')}</div>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <div className="text-xs text-gray-400">{t('verify.validFrom')}</div>
                    <div className="font-mono">{formatDate(result.certificate.validFrom)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-gray-400">{t('verify.validTo')}</div>
                    <div className="font-mono">{formatDate(result.certificate.validTo)}</div>
                  </div>
                </div>
              </div>
            </div>
          </details>
        </SigningCard>
      )}

      {result.certificateChain && result.certificateChain.length > 0 && (
        <SigningCard>
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium text-gray-400">{t('verify.certificateChain')}</div>
            {chainKnown && (
              <span
                className={`rounded-md px-3 py-1 text-xs font-medium ${
                  chainValid ? 'bg-green-100 text-green-500' : 'bg-red-100 text-red-500'
                }`}
              >
                {t(chainValid ? 'verify.chainValid' : 'verify.chainInvalid')}
              </span>
            )}
          </div>
          <CertificateChainTimeline chain={result.certificateChain} signedByName={signedByName} />
          {result.certificateChainRootNotInTrustStore && (
            <div className="mt-4 rounded-md bg-error-bg px-3 py-2 text-xs text-error-text">
              {t('signatureHistory.chain.rootNotTrusted')}
            </div>
          )}
        </SigningCard>
      )}
    </div>
  );
}
