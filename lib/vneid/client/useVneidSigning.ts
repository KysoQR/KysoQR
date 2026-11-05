'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SignatureFieldProps } from '@/lib/domain/SignatureField';
import { isEndStatus, isSignedStatus, nextPollDelay } from './polling';
import {
  fetchVneidStatus,
  finalizeVneidSigning,
  startVneidSigning,
  VneidApiError,
  type VneidLanguage,
  type VneidStatus,
  type VneidStatusView,
  type VneidTicket,
} from './vneidApi';

/**
 * One VNeID signing in the browser:
 *
 *   idle -> submitting -> waiting -> (needsCode) -> finalizing -> done
 *                                  \-> ended (refused / expired / failed)
 *
 * The original File and the client secret live in memory only (a reload
 * loses the request; the citizen's VNeID notification then just expires).
 * Polling follows lib/vneid/client/polling.ts and goes on while the page is
 * hidden: the signer is on the phone, and Chrome on Windows counts a window
 * covered by another one as hidden -- pausing then left the request waiting
 * until it expired. Every async result is tied to the run that started it, so a
 * cancelled or restarted signing can never be overwritten by a late answer.
 */

export type VneidPhase =
  | 'idle'
  | 'submitting'
  | 'waiting'
  | 'needsCode'
  | 'finalizing'
  | 'finalizeFailed'
  | 'done'
  | 'ended';

export interface VneidSigningState {
  phase: VneidPhase;
  ticket: VneidTicket | null;
  status: VneidStatus | null;
  reason: VneidStatusView['reason'] | null;
  /** Message of the last failure (already user-facing). */
  error: string | null;
  /** A status check failed; polling continues. */
  pollWarning: string | null;
  signedBlob: Blob | null;
}

const INITIAL: VneidSigningState = {
  phase: 'idle',
  ticket: null,
  status: null,
  reason: null,
  error: null,
  pollWarning: null,
  signedBlob: null,
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Slack after expiresAt before the browser gives up on its own. */
const EXPIRY_GRACE_MS = 60_000;

export function useVneidSigning(
  language: VneidLanguage,
  options: { onSigned?: (signed: Blob) => void } = {}
) {
  const [state, setState] = useState<VneidSigningState>(INITIAL);
  const onSignedRef = useRef(options.onSigned);
  useEffect(() => {
    onSignedRef.current = options.onSigned;
  });
  const runRef = useRef(0);
  const ticketRef = useRef<VneidTicket | null>(null);
  const fileRef = useRef<File | null>(null);
  const codeRef = useRef<string | undefined>(undefined);
  const finalizingRef = useRef(false);

  const reset = useCallback(() => {
    runRef.current += 1;
    ticketRef.current = null;
    fileRef.current = null;
    codeRef.current = undefined;
    finalizingRef.current = false;
    setState(INITIAL);
  }, []);

  /** Sends the request; resolves to an error message, or null when it was sent. */
  const start = useCallback(
    async (input: {
      file: File;
      fields: SignatureFieldProps[];
      citizenPid: string;
      credentialId: string;
    }): Promise<string | null> => {
      runRef.current += 1;
      const run = runRef.current;
      fileRef.current = input.file;
      ticketRef.current = null;
      codeRef.current = undefined;
      finalizingRef.current = false;
      setState({ ...INITIAL, phase: 'submitting' });
      try {
        const ticket = await startVneidSigning({ ...input, language });
        if (run !== runRef.current) return null;
        ticketRef.current = ticket;
        setState({ ...INITIAL, phase: 'waiting', ticket, status: 'PENDING' });
        return null;
      } catch (error) {
        if (run !== runRef.current) return null;
        setState(INITIAL);
        return messageOf(error);
      }
    },
    [language]
  );

  // Status polling while waiting for the signer.
  useEffect(() => {
    const ticket = ticketRef.current;
    if (state.phase !== 'waiting' || !ticket) return;
    const run = runRef.current;
    const confirmDeadline = Date.parse(ticket.confirmDeadline);
    const expiresAt = Date.parse(ticket.expiresAt);
    let cancelled = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const live = () => !cancelled && run === runRef.current;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => void tick(), ms);
    };

    const tick = async () => {
      if (!live() || inFlight) return;
      inFlight = true;
      try {
        const view = await fetchVneidStatus(ticket, language);
        if (!live()) return;
        if (isSignedStatus(view.status)) {
          setState((s) => ({
            ...s,
            status: view.status,
            pollWarning: null,
            phase: ticket.codeRequired ? 'needsCode' : 'finalizing',
          }));
          return;
        }
        if (isEndStatus(view.status)) {
          setState((s) => ({
            ...s,
            status: view.status,
            reason: view.reason ?? null,
            pollWarning: null,
            phase: 'ended',
          }));
          return;
        }
        setState((s) => ({ ...s, status: view.status, pollWarning: null }));
        if (Date.now() > expiresAt + EXPIRY_GRACE_MS) {
          setState((s) => ({ ...s, status: 'EXPIRED', reason: 'TIMEOUT', phase: 'ended' }));
          return;
        }
        schedule(nextPollDelay({ now: Date.now(), confirmDeadline }));
      } catch (error) {
        if (!live()) return;
        if (error instanceof VneidApiError && error.code === 'VNEID_NOT_FOUND') {
          // Swept on the server (long expired) or the secret was lost.
          setState((s) => ({ ...s, status: 'EXPIRED', phase: 'ended', error: error.message }));
          return;
        }
        setState((s) => ({ ...s, pollWarning: messageOf(error) }));
        schedule(
          nextPollDelay({
            now: Date.now(),
            confirmDeadline,
            failed: true,
            retryAfterSeconds: error instanceof VneidApiError ? error.retryAfterSeconds : undefined,
          })
        );
      } finally {
        inFlight = false;
      }
    };

    // Background timers may be slowed down: ask at once when the page is back.
    const onVisibility = () => {
      if (!document.hidden) {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [state.phase, language]);

  // Fetch the signed file once the signature is in.
  useEffect(() => {
    const ticket = ticketRef.current;
    const file = fileRef.current;
    if (state.phase !== 'finalizing' || !ticket || !file || finalizingRef.current) return;
    finalizingRef.current = true;
    const run = runRef.current;
    void (async () => {
      try {
        const blob = await finalizeVneidSigning(ticket, file, language, codeRef.current);
        if (run !== runRef.current) return;
        setState((s) => ({ ...s, phase: 'done', signedBlob: blob, error: null }));
        onSignedRef.current?.(blob);
      } catch (error) {
        if (run !== runRef.current) return;
        const code = error instanceof VneidApiError ? error.code : '';
        setState((s) => ({
          ...s,
          phase: code === 'VNEID_CODE_INVALID' ? 'needsCode' : 'finalizeFailed',
          error: messageOf(error),
        }));
      } finally {
        if (run === runRef.current) finalizingRef.current = false;
      }
    })();
  }, [state.phase, language]);

  const submitCode = useCallback((code: string) => {
    codeRef.current = code;
    setState((s) => ({ ...s, phase: 'finalizing', error: null }));
  }, []);

  const retryFinalize = useCallback(() => {
    setState((s) => ({ ...s, phase: 'finalizing', error: null }));
  }, []);

  return { state, start, reset, submitCode, retryFinalize };
}
