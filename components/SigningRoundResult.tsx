'use client';

import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import type { SigningRoundDetail, SigningRoundDevice } from '@/lib/cas/CasProvider';

/**
 * Ported from x-sign-web/src/features/verification/SigningRoundResult.tsx —
 * same verdict banner, status tiles, signer/device/certificate panels.
 */

type Props = {
  data: SigningRoundDetail;
};

const NOT_MODIFIED = new Set(['Không bị thay đổi', 'Not modified']);
const VALID_AT_SIGNING = new Set(['Hợp lệ tại thời điểm ký', 'Valid at signing time']);
const HAS_TIMESTAMP = new Set(['Có', 'Yes']);

/** CAS's own `taxOrCitizenId` value sometimes already comes prefixed with
 * "CCCD:"/"MST:" (e.g. "CCCD:123456789101") -- redundant once it's already
 * shown next to a "MST / CCCD" label, so it's stripped before display. */
function stripIdPrefix(value: string): string {
  return value.replace(/^\s*(CCCD|MST)\s*:\s*/i, '');
}

/** device's shape isn't documented by CAS — render whatever keys come back. */
function deviceRows(device: SigningRoundDevice): Array<[string, string]> {
  return Object.entries(device)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => [
      key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()),
      String(value),
    ]);
}

function Row({
  label,
  value,
  nowrap = false,
}: {
  label: string;
  value: string;
  /** For short, single-token-ish values (a person's name, an id number)
   * that should never break mid-value onto a second line -- most `Row`
   * values (DNs, organization names) are long-form text that's fine to
   * wrap, so this defaults to off. */
  nowrap?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-4 border-b border-border-subtle py-2.5 last:border-b-0">
      <span className="w-[130px] shrink-0 text-xs text-text-soft">{label}</span>
      <span
        className={`flex-1 text-right text-sm font-medium ${nowrap ? 'truncate whitespace-nowrap' : 'wrap-break-word'}`}
      >
        {value}
      </span>
    </div>
  );
}

function Panel({
  icon,
  title,
  children,
  right,
}: {
  icon: string;
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border-subtle bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-4">
        <div className="flex items-center gap-2.5">
          <Icon icon={icon} className="h-[17px] w-[17px] text-text-main" />
          <span className="text-[14.5px] font-semibold">{title}</span>
        </div>
        {right}
      </div>
      <div className="px-5 py-1.5">{children}</div>
    </div>
  );
}

export function SigningRoundResult({ data }: Props) {
  const { t } = useTranslation();
  const cert = data.certificate;

  const integrityOk = NOT_MODIFIED.has(cert.documentIntegrity);
  const validityOk = VALID_AT_SIGNING.has(cert.signatureValidity);
  const hasTimestamp = HAS_TIMESTAMP.has(cert.hasTimestamp);
  const isValid = integrityOk && validityOk;

  const device = deviceRows(data.device);

  const tiles = [
    {
      icon: 'lucide:file-check-2',
      label: t('signingRound.tiles.integrity'),
      value: cert.documentIntegrity,
      ok: integrityOk,
      hint: integrityOk
        ? t('signingRound.tiles.integrityHintOk')
        : t('signingRound.tiles.integrityHintBad'),
    },
    {
      icon: 'lucide:shield-check',
      label: t('signingRound.tiles.validity'),
      value: cert.signatureValidity,
      ok: validityOk,
      hint: t('signingRound.tiles.validityHint'),
    },
    {
      icon: 'lucide:clock',
      label: t('signingRound.tiles.timestamp'),
      value: cert.hasTimestamp,
      ok: hasTimestamp,
      hint: t('signingRound.tiles.timestampHint'),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Verdict */}
      <div
        className={`flex flex-wrap items-start justify-between gap-6 rounded-2xl border p-6 ${
          isValid ? 'border-border-subtle bg-surface-soft' : 'border-error-border bg-error-bg'
        }`}
      >
        <div className="flex flex-1 items-start gap-4">
          <div
            className={`flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full text-white ${
              isValid ? 'bg-primary' : 'bg-error-text'
            }`}
          >
            <Icon
              icon={isValid ? 'lucide:shield-check' : 'lucide:file-warning'}
              className="h-[26px] w-[26px]"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <div
              className={`text-[22px] font-bold tracking-tight ${isValid ? 'text-primary-strong' : 'text-error-text'}`}
            >
              {isValid
                ? t('signingRound.verdict.validTitle')
                : t('signingRound.verdict.invalidTitle')}
            </div>
            <p className="max-w-lg text-sm text-text-secondary">
              {isValid
                ? t('signingRound.verdict.validNote')
                : t('signingRound.verdict.invalidNote')}
            </p>
            {data.signedAt && (
              <div className="mt-1 flex items-center gap-2 text-[13px] text-text-secondary">
                <Icon icon="lucide:clock" className="h-3.5 w-3.5" />
                <span>
                  {t('signingRound.signedAt')}{' '}
                  <strong className="text-text-main">{data.signedAt}</strong>
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Status tiles */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {tiles.map((tile) => (
          <div
            key={tile.label}
            className="flex flex-col gap-2.5 rounded-2xl border border-border-subtle bg-white px-5 py-4.5"
          >
            <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
              <Icon icon={tile.icon} className="h-[15px] w-[15px]" />
              <span>{tile.label}</span>
            </div>
            <div
              className={`text-[16px] font-semibold leading-snug ${tile.ok ? 'text-primary-strong' : 'text-error-text'}`}
            >
              {tile.value}
            </div>
            <div className="text-[11.5px] leading-snug text-text-soft">{tile.hint}</div>
          </div>
        ))}
      </div>

      {/* Signer + device */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Panel icon="lucide:user-round-check" title={t('signingRound.signer.title')}>
          <Row
            label={t('signingRound.signer.displayName')}
            value={data.signer.displayName}
            nowrap
          />
          <Row label={t('signingRound.signer.authMethod')} value={data.authMethod} />
        </Panel>

        <Panel icon="lucide:smartphone" title={t('signingRound.device.title')}>
          {device.length > 0 ? (
            device.map(([label, value]) => <Row key={label} label={label} value={value} />)
          ) : (
            <p className="py-3 text-xs text-text-soft">{t('signingRound.device.empty')}</p>
          )}
        </Panel>
      </div>

      {/* Certificate */}
      <Panel
        icon="lucide:badge-check"
        title={t('signingRound.certificate.title')}
        right={
          <span
            className={`inline-flex h-6 items-center rounded-full px-3 text-xs font-semibold ${
              validityOk ? 'bg-surface-soft text-primary-strong' : 'bg-error-bg text-error-text'
            }`}
          >
            {cert.signatureValidity}
          </span>
        }
      >
        <div className="grid grid-cols-1 gap-x-10 py-2 sm:grid-cols-2">
          <div>
            <div className="pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-soft">
              {t('signingRound.certificate.signerSubject')}
            </div>
            <Row
              label={t('signingRound.certificate.commonName')}
              value={cert.signer.commonName ?? '—'}
            />
            <Row label={t('signingRound.certificate.country')} value={cert.signer.country ?? '—'} />
            {cert.signer.taxOrCitizenId && (
              <Row
                label={t('signingRound.certificate.taxOrCitizenId')}
                value={stripIdPrefix(cert.signer.taxOrCitizenId)}
                nowrap
              />
            )}
          </div>
          <div>
            <div className="pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-text-soft">
              {t('signingRound.certificate.issuer')}
            </div>
            <Row
              label={t('signingRound.certificate.commonName')}
              value={cert.issuer.commonName ?? '—'}
            />
            <Row
              label={t('signingRound.certificate.organization')}
              value={cert.issuer.organization ?? '—'}
            />
            <Row label={t('signingRound.certificate.country')} value={cert.issuer.country ?? '—'} />
          </div>
        </div>
        {cert.signedAtLong && (
          <div className="mb-4 mt-2 flex items-center gap-2.5 rounded-lg bg-surface-soft px-3.5 py-3 text-[13px] text-text-secondary">
            <Icon icon="lucide:calendar-check" className="h-[15px] w-[15px]" />
            <span>{cert.signedAtLong}</span>
          </div>
        )}
      </Panel>
    </div>
  );
}
