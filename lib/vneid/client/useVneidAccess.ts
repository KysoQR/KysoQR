'use client';

import { useEffect, useState } from 'react';

/** One question per page load, shared by every component that asks. */
let pending: Promise<boolean> | undefined;

function askAccess(): Promise<boolean> {
  pending ??= fetch('/api/vneid/access', { cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return ((await response.json()) as { allowed?: unknown }).allowed === true;
    })
    .catch(() => {
      // Asked again by the next component that mounts.
      pending = undefined;
      return false;
    });
  return pending;
}

/**
 * Whether this visitor may use VNeID (server-side list VNEID_TRUSTED_IPS).
 * False until the server has said yes, so nothing about VNeID shows up for a
 * moment and disappears. The VNeID API refuses an untrusted client anyway;
 * this only decides what is shown.
 */
export function useVneidAccess(): boolean {
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    let current = true;
    void askAccess().then((value) => {
      if (current) setAllowed(value);
    });
    return () => {
      current = false;
    };
  }, []);
  return allowed;
}
