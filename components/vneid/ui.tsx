import type { ReactNode } from 'react';

/**
 * Small building blocks the VNeID screens and popups share, so a status, a
 * notice or a button looks the same wherever it appears. Colours come from the
 * theme tokens in app/globals.css only (no raw green/amber/red).
 */

export type Tone = 'success' | 'warning' | 'error' | 'info';

const BADGE_TONES: Record<Tone, string> = {
  success: 'bg-surface-soft-strong text-primary-strong',
  warning: 'bg-warning-bg text-warning-text',
  error: 'bg-error-bg text-error-text',
  info: 'bg-surface-soft text-text-secondary',
};

export function Badge({
  tone,
  title,
  children,
}: {
  tone: Tone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

const NOTICE_TONES: Record<Tone, string> = {
  success: 'border-primary/50 bg-surface-soft text-text-main',
  warning: 'border-warning-border bg-warning-bg text-warning-text',
  error: 'border-error-border bg-error-bg text-error-text',
  info: 'border-border-subtle bg-surface-soft-alt text-text-secondary',
};

/** A boxed message: an error, a warning, a note. */
export function Notice({
  tone,
  className,
  children,
}: {
  tone: Tone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border px-3.5 py-2.5 text-xs ${NOTICE_TONES[tone]} ${className ?? ''}`}
    >
      {children}
    </div>
  );
}

const BUTTON_KINDS = {
  primary: 'bg-primary text-white shadow-sm hover:bg-primary-strong',
  secondary: 'border border-primary bg-white text-primary shadow-sm hover:bg-surface-soft-strong',
  ghost:
    'border border-border-subtle bg-white text-text-secondary hover:border-primary hover:text-text-main',
} as const;

const BUTTON_SIZES = { sm: 'px-3.5 py-1.5 text-xs', md: 'px-5 py-2 text-sm' } as const;

/** Rounded buttons, like components/signing/SigningButtons.tsx. */
export const buttonClass = (
  kind: keyof typeof BUTTON_KINDS,
  size: keyof typeof BUTTON_SIZES = 'md'
) =>
  `inline-flex items-center justify-center gap-1.5 rounded-full font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_KINDS[kind]} ${BUTTON_SIZES[size]}`;

/** Border and background of a card that can be picked (provider, pack, certificate). */
export const choiceCardClass = (active: boolean, faded = false) =>
  faded
    ? 'border-border-subtle bg-gray-50 opacity-60'
    : active
      ? 'border-primary bg-surface-soft ring-2 ring-primary/15'
      : 'border-border-subtle bg-white hover:border-primary/60';

/** The round "picked" mark of those cards. */
export function RadioDot({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition ${
        active ? 'border-primary bg-primary' : 'border-gray-300 bg-white'
      }`}
    >
      {active && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
    </span>
  );
}
