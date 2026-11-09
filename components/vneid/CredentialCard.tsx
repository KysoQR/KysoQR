'use client';

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { VneidCredential } from '@/lib/vneid/client/vneidApi';
import { Badge, choiceCardClass, RadioDot } from './ui';

/**
 * One certificate of a CCCD, drawn the same way in the lookup results of the
 * VNeID page, the certificate picker and the signer panel. It shows what the
 * server returns -- issuing CA, validity, key, id -- never the holder's name,
 * and the same badges everywhere: in use, why it cannot sign, a CA chain that
 * does not match, a test root.
 *
 * `radio` is a choice in the picker (an unusable one cannot be picked),
 * `button` opens something (the panel's "change certificate"), `static` only
 * shows it, with an optional `action` on the right.
 */
export function CredentialCard({
  credential,
  formatDate,
  variant = 'static',
  selected = false,
  onClick,
  disabled = false,
  action,
}: {
  credential: VneidCredential;
  formatDate: (iso: string | null | undefined) => string;
  variant?: 'radio' | 'button' | 'static';
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  action?: ReactNode;
}) {
  const { t } = useTranslation();
  const usable = credential.usable;

  const body = (
    <>
      {variant !== 'static' && (
        <span className="mt-0.5">
          <RadioDot active={selected} />
        </span>
      )}
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-xs font-semibold text-text-main">
            {t('vneid.issuedBy', { issuer: credential.issuer ?? '?' })}
          </span>
          {usable ? (
            <Badge tone="success">{t('vneidPage.activeBadge')}</Badge>
          ) : (
            credential.reason && (
              <Badge tone="error">{t(`vneid.unusable.${credential.reason}`)}</Badge>
            )
          )}
          {usable && !credential.chainVerified && (
            <Badge tone="warning" title={t('vneid.chainMismatchHint')}>
              {t('vneid.chainMismatch')}
            </Badge>
          )}
          {usable && credential.chainVerified && !credential.rootTrusted && (
            <Badge tone="warning" title={t('vneid.testRootHint')}>
              {t('vneid.testRoot')}
            </Badge>
          )}
        </span>
        <span className="block text-[11px] text-text-muted">
          {t('vneid.validity', {
            from: formatDate(credential.validFrom),
            to: formatDate(credential.validTo),
          })}
          {credential.keyBits ? ` · ${t('vneid.keyBits', { bits: credential.keyBits })}` : ''}
        </span>
        <span className="block truncate font-mono text-[10px] text-text-muted">
          {credential.credentialId}
        </span>
      </span>
      {action && <span className="shrink-0 self-center">{action}</span>}
    </>
  );

  const className = `flex w-full items-start gap-2.5 rounded-xl border p-3 text-left transition ${choiceCardClass(
    selected,
    !usable
  )}`;

  if (variant === 'static') return <div className={className}>{body}</div>;
  return (
    <button
      type="button"
      role={variant === 'radio' ? 'radio' : undefined}
      aria-checked={variant === 'radio' ? selected : undefined}
      disabled={disabled || (variant === 'radio' && !usable)}
      onClick={onClick}
      className={`${className} group disabled:cursor-not-allowed`}
    >
      {body}
    </button>
  );
}
