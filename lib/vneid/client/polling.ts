import type { VneidRegistrationStatus, VneidStatus } from './vneidApi';

/**
 * How often the browser asks /api/vneid/status (pure, so it is testable
 * without a DOM), hidden page or not. The server answers from its database and
 * asks CSign itself at most every 5 s (every 60 s once the confirm window is
 * over), so this pace costs CSign nothing extra.
 *
 *   - every 4 s while the signer can still confirm (until confirmDeadline);
 *   - every 10 s after that (a late result can still arrive by webhook);
 *   - never sooner than a 429's Retry-After;
 *   - 6 s after an error (network, 5xx), 10 s once past the deadline.
 */

export const FAST_POLL_MS = 4_000;
export const SLOW_POLL_MS = 10_000;
export const ERROR_POLL_MS = 6_000;

export function nextPollDelay(input: {
  now: number;
  confirmDeadline: number;
  failed?: boolean;
  retryAfterSeconds?: number | undefined;
}): number {
  const withinWindow = input.now < input.confirmDeadline;
  const base = input.failed
    ? withinWindow
      ? ERROR_POLL_MS
      : SLOW_POLL_MS
    : withinWindow
      ? FAST_POLL_MS
      : SLOW_POLL_MS;
  const retryAfterMs = (input.retryAfterSeconds ?? 0) * 1000;
  return Math.max(base, retryAfterMs);
}

/** The request is over, one way or the other: stop asking. */
export const isEndStatus = (status: VneidStatus) =>
  status === 'REJECTED' || status === 'EXPIRED' || status === 'FAILED';

/** The signature is in: time to fetch the signed file. */
export const isSignedStatus = (status: VneidStatus) =>
  status === 'SIGNED' || status === 'FINALIZED';

/**
 * How often the page asks /api/vneid/registrations/status: every 5 s (the
 * citizen is on the phone, sharing details and activating; a registration
 * lives 30 minutes at most), never sooner than a 429's Retry-After.
 */
export const REGISTRATION_POLL_MS = 5_000;

export const nextRegistrationPollDelay = (retryAfterSeconds?: number) =>
  Math.max(REGISTRATION_POLL_MS, (retryAfterSeconds ?? 0) * 1000);

/** Still waiting on the citizen or the CA: keep asking. */
export const isRegistrationOpen = (status: VneidRegistrationStatus) =>
  status === 'PENDING' || status === 'ISSUED';

/** 12 digits whose first three are a province code (001-096), as the server checks. */
export function isPlausibleCitizenPid(value: string): boolean {
  if (!/^[0-9]{12}$/.test(value)) return false;
  const province = Number(value.slice(0, 3));
  return province >= 1 && province <= 96;
}
