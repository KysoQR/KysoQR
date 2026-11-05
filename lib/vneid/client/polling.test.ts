import { describe, expect, it } from 'vitest';
import {
  isRegistrationOpen,
  nextRegistrationPollDelay,
  REGISTRATION_FAST_POLL_MS,
  REGISTRATION_SLOW_POLL_MS,
  ERROR_POLL_MS,
  FAST_POLL_MS,
  isEndStatus,
  isPlausibleCitizenPid,
  isSignedStatus,
  nextPollDelay,
  SLOW_POLL_MS,
} from './polling';

describe('nextPollDelay', () => {
  const deadline = 1_000_000;

  it('asks fast while the signer can confirm, slowly afterwards', () => {
    expect(nextPollDelay({ now: deadline - 1, confirmDeadline: deadline })).toBe(FAST_POLL_MS);
    expect(nextPollDelay({ now: deadline + 1, confirmDeadline: deadline })).toBe(SLOW_POLL_MS);
  });

  it('backs off after errors and never asks sooner than Retry-After', () => {
    expect(nextPollDelay({ now: 0, confirmDeadline: deadline, failed: true })).toBe(ERROR_POLL_MS);
    expect(nextPollDelay({ now: deadline + 1, confirmDeadline: deadline, failed: true })).toBe(
      SLOW_POLL_MS
    );
    expect(
      nextPollDelay({ now: 0, confirmDeadline: deadline, failed: true, retryAfterSeconds: 30 })
    ).toBe(30_000);
    expect(nextPollDelay({ now: 0, confirmDeadline: deadline, retryAfterSeconds: 1 })).toBe(
      FAST_POLL_MS
    );
  });
});

describe('status helpers', () => {
  it('tells final, signed and waiting states apart', () => {
    expect(['REJECTED', 'EXPIRED', 'FAILED'].every((s) => isEndStatus(s as never))).toBe(true);
    expect(isEndStatus('WAITING_USER')).toBe(false);
    expect(isSignedStatus('SIGNED')).toBe(true);
    expect(isSignedStatus('FINALIZED')).toBe(true);
    expect(isSignedStatus('PENDING')).toBe(false);
  });

  it('accepts only 12-digit CCCD numbers with a province code', () => {
    expect(isPlausibleCitizenPid('001099012345')).toBe(true);
    expect(isPlausibleCitizenPid('096099012345')).toBe(true);
    expect(isPlausibleCitizenPid('000099012345')).toBe(false);
    expect(isPlausibleCitizenPid('097099012345')).toBe(false);
    expect(isPlausibleCitizenPid('12345')).toBe(false);
    expect(isPlausibleCitizenPid('00109901234a')).toBe(false);
  });
});

describe('nextRegistrationPollDelay', () => {
  const createdAt = 1_000_000;
  it('asks fast for half an hour, then slowly, never sooner than Retry-After', () => {
    expect(nextRegistrationPollDelay({ now: createdAt + 60_000, createdAt })).toBe(
      REGISTRATION_FAST_POLL_MS
    );
    expect(nextRegistrationPollDelay({ now: createdAt + 31 * 60_000, createdAt })).toBe(
      REGISTRATION_SLOW_POLL_MS
    );
    expect(
      nextRegistrationPollDelay({ now: createdAt + 1000, createdAt, retryAfterSeconds: 20 })
    ).toBe(20_000);
  });

  it('keeps asking only while the registration is open', () => {
    expect(isRegistrationOpen('PENDING')).toBe(true);
    expect(isRegistrationOpen('ISSUED')).toBe(true);
    for (const status of ['COMPLETED', 'FAILED', 'REJECTED', 'EXPIRED'] as const) {
      expect(isRegistrationOpen(status)).toBe(false);
    }
  });
});
