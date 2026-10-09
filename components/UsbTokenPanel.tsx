'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import { InlineSpinner } from '@/components/signing/Spinners';
import {
  AgentRequestError,
  listAgentCertificates,
  type AgentCertificate,
} from '@/lib/agentClient';

export type SignMethod = 'cas' | 'usb';

/** "Ký bằng: Cas ID (QR) | USB Token" -- same radio-pill look as the
 * signer-kind choice in SignerConfigPanel. */
export function SignMethodSelector({
  value,
  onChange,
  disabled = false,
}: {
  value: SignMethod;
  onChange: (next: SignMethod) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div>
      <span className="block text-xs font-medium text-text-main">{t('signMethod.label')}</span>
      <div role="radiogroup" aria-label={t('signMethod.label')} className="mt-1 grid grid-cols-2 gap-2">
        {(['cas', 'usb'] as SignMethod[]).map((method) => {
          const active = value === method;
          return (
            <button
              key={method}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(method)}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50 ${
                active
                  ? 'border-primary bg-surface-soft text-primary'
                  : 'border-border-subtle bg-white text-text-secondary hover:border-primary'
              }`}
            >
              <Icon icon={method === 'usb' ? 'lucide:usb' : 'lucide:qr-code'} className="h-4 w-4" />
              {t(`signMethod.${method}`)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Translated text for an agent failure: known codes get a localized
 * message, anything else shows the agent's own (Vietnamese) message. */
export function agentErrorMessage(
  err: unknown,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  if (err instanceof AgentRequestError) {
    const key = `usbToken.errors.${err.code}`;
    const translated = t(key);
    return translated !== key ? translated : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; certificates: AgentCertificate[] };

const isUsable = (cert: AgentCertificate) => !cert.expired && !cert.notYetValid;

interface TokenGroup {
  tokenId: string;
  tokenLabel: string;
  pinStatus: NonNullable<AgentCertificate['pinStatus']>;
  usable: number;
  certificates: AgentCertificate[];
}

const NO_PIN_WARNING = { countLow: false, finalTry: false, locked: false };

function groupByToken(certificates: AgentCertificate[]): TokenGroup[] {
  const groups = new Map<string, TokenGroup>();
  for (const cert of certificates) {
    // Older agents send neither tokenId nor pinStatus: group by label then.
    const key = cert.tokenId ?? cert.tokenLabel;
    const group = groups.get(key) ?? {
      tokenId: key,
      tokenLabel: cert.tokenLabel,
      pinStatus: cert.pinStatus ?? NO_PIN_WARNING,
      usable: 0,
      certificates: [],
    };
    group.certificates.push(cert);
    if (isUsable(cert)) group.usable += 1;
    groups.set(key, group);
  }
  const byUsableFirst = (a: AgentCertificate, b: AgentCertificate) => Number(isUsable(b)) - Number(isUsable(a));
  return [...groups.values()]
    .map((group) => ({ ...group, certificates: [...group.certificates].sort(byUsableFirst) }))
    .sort((a, b) => Number(b.usable > 0) - Number(a.usable > 0));
}

/**
 * Lists the certificates on every USB token plugged into this computer (via
 * the local KysoQR Agent) as a dropdown. Only usable (in-date) certificates
 * can be picked; the only usable one is preselected.
 */
export function UsbTokenPanel({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null;
  onChange: (certId: string | null) => void;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const certificates = await listAgentCertificates();
      setState({ kind: 'ready', certificates });
      const usable = certificates.filter(isUsable);
      onChangeRef.current(usable.length === 1 ? usable[0]!.id : null);
    } catch (err) {
      setState({ kind: 'error', message: agentErrorMessage(err, t) });
      onChangeRef.current(null);
    }
  }, [t]);

  useEffect(() => {
    // Fetching from the local agent on mount is the point of this panel.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language?.startsWith('en') ? 'en-GB' : 'vi-VN');

  const certLines = (cert: AgentCertificate) => (
    <>
      <span className="block truncate text-sm font-medium text-text-main">
        {cert.commonName}
        {cert.taxOrCitizenId && <span className="font-normal text-text-muted"> · {cert.taxOrCitizenId}</span>}
      </span>
      <span className="block truncate text-[11px] text-text-muted">
        {cert.issuer} ·{' '}
        {cert.expired
          ? t('usbToken.expiredOn', { date: formatDate(cert.notAfter) })
          : cert.notYetValid
            ? t('usbToken.validFrom', { date: formatDate(cert.notBefore) })
            : t('usbToken.validUntil', { date: formatDate(cert.notAfter) })}
      </span>
    </>
  );

  const header = (
    <div className="flex items-center justify-between">
      <span className="block text-xs font-medium text-text-main">{t('usbToken.certificateLabel')}</span>
      {state.kind !== 'loading' && (
        <button
          type="button"
          onClick={() => void load()}
          disabled={disabled}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline disabled:opacity-50"
        >
          <Icon icon="lucide:refresh-cw" className="h-3 w-3" />
          {t('usbToken.refresh')}
        </button>
      )}
    </div>
  );

  if (state.kind === 'loading') {
    return (
      <div className="space-y-1">
        {header}
        <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-white px-3 py-2 text-xs text-text-muted">
          <InlineSpinner />
          {t('usbToken.loading')}
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="space-y-1">
        {header}
        <div className="rounded-md border border-error-border bg-error-bg px-3 py-2 text-xs text-error-text">
          <p>{state.message}</p>
        </div>
      </div>
    );
  }

  // One group per token (= per provider's USB token), every certificate
  // shown -- expired ones too, dimmed and not selectable. Tokens with a
  // usable certificate come first; inside a token, usable ones first.
  const groups = groupByToken(state.certificates);

  return (
    <div className="space-y-1">
      {header}
      {groups.length === 0 ? (
        <div className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-text">
          {t('usbToken.empty')}
        </div>
      ) : (
        <div role="radiogroup" aria-label={t('usbToken.certificateLabel')} className="space-y-2">
          {groups.map((group) => (
            <div key={group.tokenId} className="overflow-hidden rounded-lg border border-border-subtle bg-white">
              <div className="flex items-center gap-1.5 border-b border-border-subtle bg-surface-soft px-3 py-1.5">
                <Icon icon="lucide:usb" className="h-3.5 w-3.5 shrink-0 text-primary-strong" />
                <span className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide text-primary-strong">
                  {group.tokenLabel}
                </span>
                <span className="shrink-0 text-[10px] text-text-muted">
                  {t('usbToken.usableCount', { usable: group.usable, total: group.certificates.length })}
                </span>
              </div>
              {(group.pinStatus.countLow || group.pinStatus.finalTry || group.pinStatus.locked) && (
                <p className="flex items-start gap-1 border-b border-warning-border bg-warning-bg px-3 py-1 text-[11px] text-warning-text">
                  <Icon icon="lucide:triangle-alert" className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>
                    {group.pinStatus.locked
                      ? t('usbToken.pinLockedWarning')
                      : group.pinStatus.finalTry
                        ? t('usbToken.pinFinalTryWarning')
                        : t('usbToken.pinCountLowWarning')}
                  </span>
                </p>
              )}
              <ul className="divide-y divide-border-subtle">
                {group.certificates.map((cert) => {
                  const usable = isUsable(cert);
                  const active = cert.id === value;
                  return (
                    <li key={cert.id}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={disabled || !usable}
                        onClick={() => onChange(cert.id)}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left transition disabled:cursor-not-allowed ${
                          active ? 'bg-surface-soft' : 'enabled:hover:bg-surface-soft'
                        } ${usable ? '' : 'opacity-50'}`}
                      >
                        <span
                          aria-hidden="true"
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                            active ? 'border-primary' : 'border-border-subtle'
                          }`}
                        >
                          {active && <span className="h-2 w-2 rounded-full bg-primary" />}
                        </span>
                        <span className="min-w-0 flex-1">{certLines(cert)}</span>
                        {!usable && (
                          <span className="shrink-0 rounded-full bg-error-bg px-2 py-0.5 text-[10px] font-medium text-error-text">
                            {cert.expired ? t('usbToken.expired') : t('usbToken.notYetValid')}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      <p className="flex items-start gap-1 pt-0.5 text-[11px] text-text-muted">
        <Icon icon="lucide:lock" className="mt-0.5 h-3 w-3 shrink-0" />
        <span>{t('usbToken.pinHint')}</span>
      </p>
    </div>
  );
}

export default UsbTokenPanel;
