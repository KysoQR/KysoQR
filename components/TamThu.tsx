'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { VerificationPopup } from './VerificationPopup';

/** HTML of the optional `tamthu.md` (read on the server in app/layout.tsx),
 * or `null` when that file doesn't exist -- then "Vì sao / Ký số QR" does
 * not open a letter. */
const TamThuContext = createContext<string | null>(null);

export function TamThuProvider({ html, children }: { html: string | null; children: ReactNode }) {
  return <TamThuContext.Provider value={html}>{children}</TamThuContext.Provider>;
}

export function useTamThuHtml(): string | null {
  return useContext(TamThuContext);
}

export function TamThuPopup({ html, onClose }: { html: string; onClose: () => void }) {
  // VerificationPopup only sees Escape while it has focus, which it doesn't
  // get when opened from a header button -- listen on the window instead.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <VerificationPopup onClose={onClose}>
      {/* Trusted content: tamthu.md is part of this codebase. */}
      <div className="md-content" dangerouslySetInnerHTML={{ __html: html }} />
    </VerificationPopup>
  );
}
