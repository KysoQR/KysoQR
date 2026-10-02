'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@iconify/react';

/** Past this many pixels of scrolling the user has clearly found the page below. */
const SCROLLED_ENOUGH_PX = 120;

/**
 * Floating "scroll down" hint pinned to the bottom-centre of the viewport,
 * pointing at the element with id `targetId`. It only shows while that
 * element is still off-screen and the user hasn't scrolled yet, so on a
 * window tall enough to show the target already it never appears. Clicking
 * it scrolls the target into view.
 *
 * Starts hidden and decides on mount, so the server and the client's first
 * render agree (no hydration mismatch).
 */
export function ScrollCue({ targetId, label }: { targetId: string; label: string }) {
  const [targetVisible, setTargetVisible] = useState(true);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const target = document.getElementById(targetId);
    if (!target) return;

    const observer = new IntersectionObserver(
      ([entry]) => setTargetVisible(entry?.isIntersecting ?? false),
      // Count the target as "visible" once its top edge is ~80px into view.
      { rootMargin: '0px 0px -80px 0px' }
    );
    observer.observe(target);

    const onScroll = () => setScrolled(window.scrollY > SCROLLED_ENOUGH_PX);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
  }, [targetId]);

  const show = !targetVisible && !scrolled;

  const handleClick = () => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document
      .getElementById(targetId)
      ?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <div
      aria-hidden={!show}
      className={`pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center px-4 transition-all duration-300 ${
        show ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'
      }`}
    >
      <button
        type="button"
        onClick={handleClick}
        tabIndex={show ? 0 : -1}
        className={`animate-ky-ripple inline-flex min-h-11 items-center gap-2 rounded-full bg-primary py-2 pl-5 pr-3 text-sm font-semibold text-white shadow-lg shadow-primary/30 transition-colors hover:bg-primary-strong ${
          show ? 'pointer-events-auto' : ''
        }`}
      >
        <span>{label}</span>
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20">
          <Icon icon="lucide:chevrons-down" className="animate-scroll-cue h-4 w-4" />
        </span>
      </button>
    </div>
  );
}
