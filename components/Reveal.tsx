'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Fades its content in and slides it up 16px the first time it scrolls into
 * view. Rendered visible on the server and only switched to the "hidden,
 * waiting" state on mount when the element is still below the fold -- so
 * nothing is ever stuck invisible if JS is slow, and content already on
 * screen doesn't flicker. Skipped entirely under prefers-reduced-motion.
 */
export function Reveal({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'static' | 'waiting' | 'shown'>('static');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;

    setState('waiting');
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setState('shown');
          observer.disconnect();
        }
      },
      { rootMargin: '0px 0px -10% 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`${
        state === 'static'
          ? ''
          : `transition-all duration-700 ease-out ${
              state === 'shown' ? 'translate-y-0 opacity-100' : 'translate-y-4 opacity-0'
            }`
      } ${className}`}
    >
      {children}
    </div>
  );
}
