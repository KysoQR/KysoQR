'use client';

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExpiresIn } from '@/components/signing/ExpiresIn';
import { SigningCard } from '@/components/signing/SigningCard';
import { SigningStepHeader } from '@/components/signing/SigningStepHeader';
import { InlineSpinner } from '@/components/signing/Spinners';
import type { VneidSigningState } from '@/lib/vneid/client/useVneidSigning';
import { buttonClass, Notice } from './ui';

/**
 * Step 3 for VNeID (instead of the Cas ID QR): tells the signer what to do in
 * the VNeID app, counts down the 5-minute confirmation window and follows
 * the request until the signed file is ready -- or says why it ended.
 */
export function VneidWaitingCard({
  state,
  progressLabel,
  onCancel,
  onSubmitCode,
  onRetryFinalize,
  onSignAgain,
  onStartOver,
}: {
  state: VneidSigningState;
  progressLabel: string;
  onCancel: () => void;
  onSubmitCode: (code: string) => void;
  onRetryFinalize: () => void;
  onSignAgain: () => void;
  onStartOver: () => void;
}) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [confirmWindowOver, setConfirmWindowOver] = useState(false);
  const markWindowOver = useCallback(() => setConfirmWindowOver(true), []);
  const { phase, ticket } = state;
  const waiting = phase === 'waiting' || phase === 'needsCode';

  return (
    <SigningCard className="flex flex-col">
      <SigningStepHeader
        stepNumber={3}
        title={t('vneid.waiting.title')}
        trailingContent={progressLabel}
      />
      <p className="mt-1 text-sm text-text-muted">{t('vneid.waiting.subtitle')}</p>

      <div className="mx-auto mt-6 grid w-full max-w-3xl gap-8 md:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex flex-col items-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- static brand mark */}
          <img src="/brand/vneid.svg" alt="VNeID" className="h-24 w-24" />
          {waiting && ticket && !confirmWindowOver && (
            <div className="mt-3">
              <ExpiresIn
                expiresAt={ticket.confirmDeadline}
                onExpired={markWindowOver}
                messageKey="vneid.waiting.confirmIn"
              />
            </div>
          )}
        </div>

        <div className="space-y-3 text-sm text-text-main">
          <ol className="list-decimal space-y-1 pl-5">
            <li>{t('vneid.waiting.step1')}</li>
            <li>{t('vneid.waiting.step2')}</li>
            <li>{t('vneid.waiting.step3')}</li>
          </ol>

          {ticket && (
            <div className="rounded-xl border border-border-subtle bg-surface-soft px-3 py-2">
              <div className="text-xs text-text-muted">{t('vneid.waiting.documentNameLabel')}</div>
              <div className="font-mono text-sm font-semibold text-primary-strong">
                {ticket.documentName}
              </div>
            </div>
          )}

          {phase === 'waiting' && (
            <p className="flex items-center gap-2 text-sm text-text-secondary" aria-live="polite">
              <span
                className="h-2 w-2 animate-pulse rounded-full bg-warning-strong"
                aria-hidden="true"
              />
              {confirmWindowOver
                ? t('vneid.waiting.confirmWindowOver')
                : t(`vneid.waiting.status.${state.status ?? 'PENDING'}`)}
            </p>
          )}

          {state.pollWarning && phase === 'waiting' && (
            <Notice tone="warning">
              {t('vneid.waiting.statusWarning')} {state.pollWarning}
            </Notice>
          )}

          {phase === 'needsCode' && (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                onSubmitCode(code);
              }}
            >
              <label htmlFor="vneid-code" className="block text-xs font-medium text-text-main">
                {t('vneid.waiting.codeLabel')}
              </label>
              <div className="flex gap-2">
                <input
                  id="vneid-code"
                  value={code}
                  onChange={(event) =>
                    setCode(
                      event.target.value
                        .replace(/[^0-9A-Za-z]/g, '')
                        .slice(0, 6)
                        .toUpperCase()
                    )
                  }
                  autoComplete="off"
                  className="w-32 rounded-lg border border-border-subtle px-3 py-1.5 font-mono text-sm uppercase tracking-widest outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
                <button
                  type="submit"
                  disabled={code.length !== 6}
                  className={buttonClass('primary')}
                >
                  {t('vneid.waiting.codeSubmit')}
                </button>
              </div>
              {state.error && <p className="text-xs text-error-text">{state.error}</p>}
            </form>
          )}

          {phase === 'finalizing' && (
            <p className="flex items-center gap-2 text-sm text-text-secondary" aria-live="polite">
              <InlineSpinner />
              {t('vneid.waiting.finalizing')}
            </p>
          )}

          {phase === 'finalizeFailed' && (
            <div className="space-y-2">
              <Notice tone="error" className="text-sm">
                {t('vneid.waiting.finalizeFailed')} {state.error}
              </Notice>
              <button type="button" onClick={onRetryFinalize} className={buttonClass('primary')}>
                {t('vneid.waiting.retry')}
              </button>
            </div>
          )}

          {phase === 'ended' && (
            <div className="space-y-3">
              <Notice tone="error" className="text-sm">
                <p>
                  {t(
                    `vneid.waiting.ended.${state.status === 'REJECTED' || state.status === 'EXPIRED' ? state.status : 'FAILED'}`
                  )}
                </p>
                {state.reason && state.reason !== 'REFUSED' && state.reason !== 'TIMEOUT' && (
                  <p className="mt-1 text-xs">{t(`vneid.waiting.reason.${state.reason}`)}</p>
                )}
                {state.error && <p className="mt-1 text-xs">{state.error}</p>}
              </Notice>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={onSignAgain} className={buttonClass('primary')}>
                  {t('vneid.waiting.signAgain')}
                </button>
                <button type="button" onClick={onStartOver} className={buttonClass('secondary')}>
                  {t('common.startOver')}
                </button>
              </div>
            </div>
          )}

          {waiting && (
            <div className="pt-2">
              <button type="button" onClick={onCancel} className={buttonClass('ghost', 'sm')}>
                {t('vneid.waiting.cancel')}
              </button>
              <p className="mt-1 text-[11px] text-text-muted">{t('vneid.waiting.cancelNote')}</p>
            </div>
          )}
        </div>
      </div>
    </SigningCard>
  );
}
