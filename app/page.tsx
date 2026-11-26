'use client';

import '@/lib/i18n/init';
import { useEffect, useState } from 'react';
import { HomeLanding } from '@/components/HomeLanding';
import { SigningWizard } from '@/components/SigningWizard';
import type { RecentSignature } from '@/lib/recentSignatures';
import { getActiveSession } from '@/lib/activeSession';
import { SESSION_KEYS, getSessionItem } from '@/lib/signingSessionStorage';
import { cleanupBrowserStorage } from '@/lib/browserHistory';

/**
 * `/` — matches x-sign-web's real routing: a marketing landing page
 * (HomeLanding) is what a first-time visitor sees; dropping/choosing a file
 * there hands off into the signing wizard (SigningWizard). The two are
 * separate routes in x-sign-web (`/` vs `/signing`) — collapsed into one
 * route here since there's no `documentId` to carry in a URL any more
 * (stateless, no DB), so the handoff is a plain client-side view toggle
 * instead of a navigation.
 *
 * An in-progress signing session (found in localStorage) resumes straight
 * into the wizard on load, same as reloading `/signing` used to in the old
 * app — a session that already reached a terminal status is cleared as soon
 * as it gets there (see SigningWizard), so there is nothing to resume by then.
 */
type View = 'home' | 'wizard';

const TERMINAL_STATUSES = new Set(['SIGNED', 'REJECTED', 'FAILED', 'EXPIRED']);

export default function Page() {
  const [view, setView] = useState<View>('home');
  const [entryFile, setEntryFile] = useState<File | null>(null);
  /** A "phiên ký gần nhất" opened from the home page (entryFile is then its
   * signed PDF) -- the wizard shows it read-only first. */
  const [entryReview, setEntryReview] = useState<RecentSignature | null>(null);

  useEffect(() => {
    // Whatever page the app opens on: delete what is past the 30-minute TTL
    // (recent list, stored PDFs, expired session) -- see lib/browserHistory.ts.
    void cleanupBrowserStorage();
    // This tab's round only (sessionStorage): F5 reopens it, a new tab or a
    // fresh visit starts on the home page.
    const savedId = getSessionItem(SESSION_KEYS.signRequestId);
    const savedStatus = getSessionItem(SESSION_KEYS.status);
    // Deliberate one-time resume check from sessionStorage (browser-only) after
    // mount — a lazy useState initializer would run during SSR too and
    // mismatch on hydration, so a mount effect is the correct pattern here.
    // Also reopen a session whose result was on screen (signed / failed),
    // see lib/activeSession.ts -- the wizard restores it itself.
    if ((savedId && savedStatus && !TERMINAL_STATUSES.has(savedStatus)) || getActiveSession()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setView('wizard');
    }
  }, []);

  if (view === 'wizard') {
    return (
      <SigningWizard
        initialFile={entryFile}
        initialReview={entryReview}
        onBackToHome={() => {
          setEntryFile(null);
          setEntryReview(null);
          setView('home');
        }}
      />
    );
  }

  return (
    <HomeLanding
      onFileAccepted={(file) => {
        setEntryFile(file);
        setEntryReview(null);
        setView('wizard');
      }}
      onResumePending={() => {
        setEntryFile(null);
        setEntryReview(null);
        setView('wizard');
      }}
      onRecentOpened={(file, entry) => {
        setEntryFile(file);
        setEntryReview(entry);
        setView('wizard');
      }}
    />
  );
}
