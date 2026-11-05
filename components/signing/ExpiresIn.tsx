'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Ported verbatim (logic) from x-sign-web/src/components/signing/ExpiresIn.tsx. */
export function ExpiresIn({
  expiresAt,
  onExpired,
  messageKey = 'scan.expiresIn',
}: {
  expiresAt: string | null;
  onExpired?: () => void;
  /** i18n key of the sentence, given `{{time}}` (m:ss). */
  messageKey?: string;
}) {
  const { t } = useTranslation();
  const [remainingMs, setRemainingMs] = useState<number | null>(null);

  useEffect(() => {
    if (!expiresAt) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting on prop change, not a derived-state anti-pattern
      setRemainingMs(null);
      return;
    }
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const targetTime = new Date(expiresAt).getTime();
    if (Number.isNaN(targetTime)) {
      setRemainingMs(null);
      return;
    }
    const tick = () => {
      if (cancelled) return;
      const delta = targetTime - Date.now();
      const clamped = delta > 0 ? delta : 0;
      setRemainingMs(clamped);
      if (delta <= 0) {
        onExpired?.();
        return;
      }
      timeoutId = setTimeout(tick, 1000);
    };
    tick();
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    };
  }, [expiresAt, onExpired]);

  if (!expiresAt || remainingMs === null) return null;

  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const timeLabel = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  return <span className="text-xs text-text-muted">{t(messageKey, { time: timeLabel })}</span>;
}
