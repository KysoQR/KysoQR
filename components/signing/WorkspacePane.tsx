'use client';

import { Icon } from '@iconify/react';
import type { ReactNode, Ref } from 'react';

/**
 * One of the 3 zones of the signing wizard's placement step (signature
 * history / PDF / signer info): a bordered box with a fixed title bar and a
 * body.
 *
 * At `lg` and up the wizard gives the 3 panes a fixed, viewport-sized row
 * and each body scrolls on its own (`overflow-y-auto`), so the wheel only
 * moves the pane under the pointer -- `overscroll-contain` stops a pane
 * that hits its end from scrolling the page or a neighbour instead. Below
 * `lg` the panes stack and the body is a plain block: the page keeps a
 * single ordinary scroll on phones.
 */
export function WorkspacePane({
  title,
  icon,
  actions,
  className,
  bodyClassName,
  paneRef,
  bodyRef,
  children,
}: {
  title: ReactNode;
  icon: string;
  /** Right side of the title bar (e.g. a close button). */
  actions?: ReactNode;
  className?: string;
  bodyClassName?: string;
  paneRef?: Ref<HTMLDivElement>;
  /** The scrolling element (wide screens) -- e.g. the PDF pane hands it to
   * `SignaturePlacement` as its `scrollRoot`. */
  bodyRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <section
      ref={paneRef}
      className={[
        'flex min-w-0 flex-col overflow-hidden rounded-xl border border-border-subtle bg-white lg:min-h-0',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-surface-soft px-3 py-2">
        <Icon icon={icon} className="h-4 w-4 shrink-0 text-primary-strong" />
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-text-strong">
          {title}
        </h3>
        {actions}
      </header>
      <div
        ref={bodyRef}
        className={[
          'p-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain',
          bodyClassName,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {children}
      </div>
    </section>
  );
}
