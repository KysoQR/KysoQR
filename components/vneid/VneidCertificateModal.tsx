'use client';

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import type { VneidCredential } from '@/lib/vneid/client/vneidApi';
import { CredentialCard } from './CredentialCard';
import { buttonClass } from './ui';
import { VneidModal } from './VneidModal';

export interface VneidCertificateModalProps {
  credentials: VneidCredential[];
  selectedCredentialId: string | null;
  onSelect: (credentialId: string) => void;
  onClose: () => void;
  formatDate: (iso: string | null | undefined) => string;
  /** Shows "Register a new certificate" in the footer. */
  onRegister?: () => void;
}

/** Picks the certificate to sign with: a searchable grid of the CCCD's
 * certificates, the same cards as the VNeID page's lookup. */
export function VneidCertificateModal({
  credentials,
  selectedCredentialId,
  onSelect,
  onClose,
  formatDate,
  onRegister,
}: VneidCertificateModalProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const filteredCredentials = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return credentials;
    return credentials.filter((c) => {
      const issuer = (c.issuer ?? '').toLowerCase();
      const id = (c.credentialId ?? '').toLowerCase();
      return issuer.includes(trimmed) || id.includes(trimmed);
    });
  }, [credentials, query]);

  const search =
    credentials.length > 2 ? (
      <div className="relative">
        <Icon
          icon="lucide:search"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('vneid.searchCredentialPlaceholder')}
          className="w-full rounded-lg border border-border-subtle bg-white py-1.5 pl-9 pr-8 text-xs text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label={t('common.close')}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main"
          >
            <Icon icon="lucide:x" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    ) : undefined;

  return (
    <VneidModal
      size="xl"
      title={t('vneid.credentialsTitle')}
      subtitle={t('vneid.modalCertCount', { count: credentials.length })}
      onClose={onClose}
      toolbar={search}
      footer={
        <>
          <span className="text-[11px] text-text-muted">{t('vneid.selectCredential')}</span>
          <div className="flex flex-wrap items-center gap-2">
            {onRegister && (
              <button type="button" onClick={onRegister} className={buttonClass('secondary', 'sm')}>
                <Icon icon="lucide:plus" className="h-3.5 w-3.5" />
                {t('vneid.register.openButton')}
              </button>
            )}
            <button type="button" onClick={onClose} className={buttonClass('ghost', 'sm')}>
              {t('common.close')}
            </button>
          </div>
        </>
      }
    >
      {filteredCredentials.length === 0 ? (
        <p className="py-6 text-center text-xs text-text-muted">{t('vneid.noMatchingCerts')}</p>
      ) : (
        <div
          role="radiogroup"
          aria-label={t('vneid.credentialsTitle')}
          className="grid gap-2.5 md:grid-cols-2 xl:grid-cols-3"
        >
          {filteredCredentials.map((credential) => (
            <CredentialCard
              key={credential.credentialId}
              credential={credential}
              formatDate={formatDate}
              variant="radio"
              selected={selectedCredentialId === credential.credentialId}
              onClick={() => {
                onSelect(credential.credentialId);
                onClose();
              }}
            />
          ))}
        </div>
      )}
    </VneidModal>
  );
}
