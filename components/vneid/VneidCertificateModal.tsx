'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import type { VneidCredential } from '@/lib/vneid/client/vneidApi';

export interface VneidCertificateModalProps {
  credentials: VneidCredential[];
  selectedCredentialId: string | null;
  onSelect: (credentialId: string) => void;
  onClose: () => void;
  formatDate: (iso: string | null | undefined) => string;
}

export function VneidCertificateModal({
  credentials,
  selectedCredentialId,
  onSelect,
  onClose,
  formatDate,
}: VneidCertificateModalProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Focus the dialog so Escape closes it without a click first.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const filteredCredentials = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return credentials;
    return credentials.filter((c) => {
      const issuer = (c.issuer ?? '').toLowerCase();
      const id = (c.credentialId ?? '').toLowerCase();
      return issuer.includes(trimmed) || id.includes(trimmed);
    });
  }, [credentials, query]);

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 outline-none"
      role="dialog"
      aria-modal="true"
      aria-labelledby="vneid-cert-modal-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      tabIndex={-1}
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl border border-border-subtle bg-white shadow-xl">
        {/* Modal Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div>
            <h2 id="vneid-cert-modal-title" className="text-base font-semibold text-text-main">
              {t('vneid.credentialsTitle')}
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">
              {t('vneid.modalCertCount', { count: credentials.length })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-text-muted transition hover:bg-surface-soft hover:text-text-main"
            aria-label={t('common.close', 'Đóng')}
          >
            <Icon icon="lucide:x" className="h-5 w-5" />
          </button>
        </div>

        {/* Search Bar when multiple certificates exist */}
        {credentials.length > 2 && (
          <div className="border-b border-border-subtle bg-surface-soft/60 px-5 py-2.5">
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
                className="w-full rounded-lg border border-border-subtle bg-white py-1.5 pl-9 pr-3 text-xs text-text-main placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-main"
                >
                  <Icon icon="lucide:x" className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Certificate List */}
        <div
          role="radiogroup"
          aria-label={t('vneid.credentialsTitle')}
          className="flex-1 space-y-2 overflow-y-auto p-5"
        >
          {filteredCredentials.length === 0 ? (
            <p className="py-6 text-center text-xs text-text-muted">
              {t('vneid.noMatchingCerts')}
            </p>
          ) : (
            filteredCredentials.map((credential) => {
              const active = selectedCredentialId === credential.credentialId;
              return (
                <button
                  key={credential.credentialId}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={!credential.usable}
                  onClick={() => {
                    if (credential.usable) {
                      onSelect(credential.credentialId);
                      onClose();
                    }
                  }}
                  className={`flex w-full items-start gap-2.5 rounded-xl border p-3 text-left text-xs transition disabled:cursor-not-allowed ${
                    active
                      ? 'border-primary bg-surface-soft shadow-xs'
                      : credential.usable
                        ? 'border-border-subtle bg-white hover:border-primary hover:bg-surface-soft/40'
                        : 'border-border-subtle bg-gray-50 opacity-60'
                  }`}
                >
                  <Icon
                    icon={active ? 'lucide:circle-dot' : 'lucide:circle'}
                    className={`mt-0.5 h-4 w-4 shrink-0 ${active ? 'text-primary' : 'text-text-muted'}`}
                  />
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold text-text-main">
                        {t('vneid.issuedBy', { issuer: credential.issuer ?? '?' })}
                      </span>
                      {active && (
                        <span className="inline-flex shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                          {t('common.selected', 'Đang chọn')}
                        </span>
                      )}
                    </span>
                    <span className="block text-text-muted">
                      {t('vneid.validity', {
                        from: formatDate(credential.validFrom),
                        to: formatDate(credential.validTo),
                      })}
                      {credential.keyBits
                        ? ` · ${t('vneid.keyBits', { bits: credential.keyBits })}`
                        : ''}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-text-muted">
                      {credential.credentialId}
                    </span>
                    {!credential.usable && credential.reason && (
                      <span className="block font-medium text-error-text">
                        {t(`vneid.unusable.${credential.reason}`)}
                      </span>
                    )}
                    {credential.usable && !credential.chainVerified && (
                      <span
                        className="mt-1 inline-flex rounded-full bg-warning-bg px-2 py-0.5 text-[10px] font-medium text-warning-text"
                        title={t('vneid.chainMismatchHint')}
                      >
                        {t('vneid.chainMismatch')}
                      </span>
                    )}
                    {credential.usable && credential.chainVerified && !credential.rootTrusted && (
                      <span
                        className="mt-1 inline-flex rounded-full bg-warning-bg px-2 py-0.5 text-[10px] font-medium text-warning-text"
                        title={t('vneid.testRootHint')}
                      >
                        {t('vneid.testRoot')}
                      </span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between border-t border-border-subtle bg-surface-soft/40 px-5 py-3">
          <span className="text-[11px] text-text-muted">
            {t('vneid.selectCredential')}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border-subtle bg-white px-4 py-1.5 text-xs font-semibold text-text-main shadow-xs transition hover:bg-surface-soft"
          >
            {t('common.close', 'Đóng')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
