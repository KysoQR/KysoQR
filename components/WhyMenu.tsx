'use client';

import { createContext, useContext, type ReactNode } from 'react';

const WhyMenuContext = createContext(false);

/** True when the server has a non-empty `public/why.html`. */
export function WhyMenuProvider({
  available,
  children,
}: {
  available: boolean;
  children: ReactNode;
}) {
  return <WhyMenuContext.Provider value={available}>{children}</WhyMenuContext.Provider>;
}

export function useWhyMenu(): boolean {
  return useContext(WhyMenuContext);
}
