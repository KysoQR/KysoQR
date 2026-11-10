'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isRegistrationOpen, nextRegistrationPollDelay } from './polling';
import {
  fetchVneidRegistration,
  VneidApiError,
  type VneidLanguage,
  type VneidRegistration,
} from './vneidApi';

/**
 * The certificate registration of the CCCD on screen, as the server keeps it.
 *
 * The browser holds nothing that must survive a reload: the server stores the
 * registration under the CCCD, so typing the CCCD again and calling refresh()
 * picks it up where it was. While it is open (PENDING / ISSUED) the hook asks
 * again on the pace of polling.ts, hidden page or not, and calls onCompleted
 * once with the new certificate's credentialId. It leaves the page at its
 * expiresAt (30 minutes after it was sent), when the server deletes it.
 * Answers for a CCCD that is no longer the one on screen are dropped.
 */
export function useVneidRegistration(options: {
  citizenPid: string;
  language: VneidLanguage;
  onCompleted?: (credentialId: string) => void;
}) {
  const { citizenPid, language } = options;
  const [registration, setRegistration] = useState<VneidRegistration | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [rearm, setRearm] = useState(0);
  const retryAfter = useRef<number | undefined>(undefined);
  const currentPid = useRef(citizenPid);
  const onCompleted = useRef(options.onCompleted);
  const notified = useRef<string | null>(null);
  useEffect(() => {
    currentPid.current = citizenPid;
  }, [citizenPid]);
  useEffect(() => {
    onCompleted.current = options.onCompleted;
  });

  /** Asks the server now; resolves with what it said (also kept in state). */
  const refresh = useCallback(async (): Promise<VneidRegistration | null> => {
    const pid = citizenPid;
    const next = await fetchVneidRegistration(pid, language);
    if (currentPid.current === pid) {
      setRegistration(next);
      setPollError(null);
    }
    return next;
  }, [citizenPid, language]);

  /** A registration that was just sent (the answer of POST /registrations). */
  const track = useCallback((next: VneidRegistration) => {
    retryAfter.current = undefined;
    setPollError(null);
    setRegistration(next);
  }, []);

  const clear = useCallback(() => {
    setRegistration(null);
    setPollError(null);
    notified.current = null;
  }, []);

  useEffect(() => {
    if (!registration || !isRegistrationOpen(registration.status)) return;
    let cancelled = false;
    const pid = citizenPid;
    const delay = nextRegistrationPollDelay(retryAfter.current);
    const timer = window.setTimeout(async () => {
      try {
        const next = await fetchVneidRegistration(pid, language);
        if (cancelled || currentPid.current !== pid) return;
        retryAfter.current = undefined;
        setPollError(null);
        // A new object even when nothing changed: the effect runs again.
        setRegistration(next);
      } catch (caught) {
        if (cancelled) return;
        retryAfter.current = caught instanceof VneidApiError ? caught.retryAfterSeconds : undefined;
        setPollError(caught instanceof Error ? caught.message : String(caught));
        setRearm((count) => count + 1);
      }
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [registration, citizenPid, language, rearm]);

  // A registration lives until expiresAt (30 minutes after it was sent); the
  // server deletes it then, so it leaves the page too, finished or not.
  useEffect(() => {
    if (!registration) return;
    const timer = window.setTimeout(
      () => setRegistration(null),
      Math.max(0, Date.parse(registration.expiresAt) - Date.now())
    );
    return () => window.clearTimeout(timer);
  }, [registration]);

  useEffect(() => {
    const serial = registration?.status === 'COMPLETED' ? registration.serialNumber : undefined;
    if (!serial || notified.current === serial) return;
    notified.current = serial;
    onCompleted.current?.(serial);
  }, [registration]);

  return { registration, pollError, refresh, track, clear };
}
