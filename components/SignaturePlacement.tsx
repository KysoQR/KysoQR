'use client';

import {
  type Dispatch,
  type SetStateAction,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
// pdf.js "legacy" build (library + worker below): the default build touches
// the global `Iterator` at load time, which Safari/iOS < 18.4 (and every
// in-app browser on those iPhones) doesn't have -- that crashed the whole
// page. The legacy build ships the needed polyfills.
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import {
  MAX_HEIGHT_RATIO,
  MIN_HEIGHT_RATIO,
  MIN_WIDTH_RATIO,
  clamp,
  makeAvailableField,
  type SignatureFieldProps,
  type VisibleBand,
} from '@/lib/domain/SignatureField';

if (!GlobalWorkerOptions.workerSrc) {
  GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString();
}

/**
 * Ported from x-sign-web/src/components/SignaturePlacement.tsx originally;
 * rewritten this session to show every page stacked in one continuously
 * scrollable panel (was: one page at a time + "Trang trước"/"Trang sau"
 * buttons) -- matches how continuous-scroll document viewers (Google Docs,
 * Notion, PDF readers) behave. Pages are lazily rasterized as they scroll
 * near the viewport (IntersectionObserver), never all at once, so this
 * stays cheap regardless of document length. The "add signature box" action
 * targets whichever page is currently most visible while scrolling. A box
 * only ever moves by dragging it (or its resize handle): clicking the page
 * just deselects -- an earlier "the next click places the new box" mode was
 * removed (per explicit request), since a stray click would jump the box.
 *
 * Also supports manual +/- zoom (`zoomFactor`, independent of the
 * container-width auto-fit scale) -- zooming in makes rendered pages wider
 * than the stage; each page's wrapper gets an explicit pixel width
 * (`containerWidth * zoomFactor`) rather than `w-full` so its CSS
 * `aspect-ratio`-derived height keeps matching the (now wider) canvas
 * instead of clipping it.
 *
 * The page/zoom toolbar and "add signature box" button used to render
 * inside this component; they now render in SigningWizard.tsx's own toolbar
 * row (below the site header), so this component exposes its display state
 * via the `on*Change` callbacks below and its actions via `ref` (a plain
 * controlled-props API doesn't fit `addFieldToPage`/`scrollToPage`, which
 * depend on internal refs like `pageWrapperRefs`/`pageMetrics` that aren't
 * practical to lift up to the parent). The stage itself no longer clamps or
 * scrolls its own height -- it grows to its natural content height and
 * scrolls along with the rest of the page (see SigningWizard.tsx's single
 * page-level scroll).
 */
type SignaturePlacementProps = {
  file: File;
  fields: SignatureFieldProps[];
  onFieldsChange: Dispatch<SetStateAction<SignatureFieldProps[]>>;
  disabled?: boolean;
  onVisiblePageChange?: (page: number) => void;
  onPageCountChange?: (count: number | null) => void;
  onZoomFactorChange?: (zoom: number) => void;
  onCanAddFieldChange?: (canAdd: boolean) => void;
  /** Height (px) of whatever sticks to the top of the viewport above the
   * pages (the wizard's header + toolbar). Excluded when deciding which page
   * is "visible", and used as the offset when jumping to a page. */
  topInset?: number;
  /** The element the pages scroll inside (the wizard's own PDF pane on
   * wide screens). `null`/omitted: the window scrolls, as on phones --
   * `topInset` then applies. With a scroll root, the visible area and
   * page jumps are measured against that element instead. */
  scrollRoot?: HTMLElement | null;
};

export type SignaturePlacementHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  addField: () => void;
  goToPage: (page: number) => void;
  /** Select a box and scroll it into view (the wizard's field list). */
  focusField: (index: number) => void;
  /** Same as the box's own "Xoá" button. */
  removeField: (index: number) => void;
};

/**
 * 1-based number shown on each box, counted across the whole document
 * (page order, then creation order within a page) so it matches the
 * wizard's total "N ô ký" counter and its field list. Deliberately not by
 * on-page position: that would renumber boxes while one is being dragged
 * up or down. Returns `ordinals[fieldIndex]`.
 */
export function fieldOrdinals(fields: readonly SignatureFieldProps[]): number[] {
  const indexesByPage = new Map<number, number[]>();
  fields.forEach((field, index) => {
    const list = indexesByPage.get(field.page) ?? [];
    list.push(index);
    indexesByPage.set(field.page, list);
  });
  const ordinals: number[] = [];
  let next = 1;
  [...indexesByPage.keys()]
    .sort((a, b) => a - b)
    .forEach((page) => {
      for (const index of indexesByPage.get(page) ?? []) ordinals[index] = next++;
    });
  return ordinals;
}

type PageMetrics = { widthPx: number; heightPx: number };
type PdfPage = Awaited<ReturnType<PDFDocumentProxy['getPage']>>;
type PdfRenderTask = ReturnType<PdfPage['render']>;
type FieldEntry = { field: SignatureFieldProps; index: number };

const RENDER_ROOT_MARGIN = '800px 0px';
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.25;
/** 100% = the page fits the stage's inner width (see renderPage). */
const DEFAULT_ZOOM = 1;

function SignaturePlacementInner(
  {
    file,
    fields,
    onFieldsChange,
    disabled,
    onVisiblePageChange,
    onPageCountChange,
    onZoomFactorChange,
    onCanAddFieldChange,
    topInset = 0,
    scrollRoot = null,
  }: SignaturePlacementProps,
  ref: React.Ref<SignaturePlacementHandle>
) {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const canvasRefs = useRef(new Map<number, HTMLCanvasElement>());
  const overlayRefs = useRef(new Map<number, HTMLDivElement>());
  const pageWrapperRefs = useRef(new Map<number, HTMLDivElement>());
  const renderTasksRef = useRef(new Map<number, PdfRenderTask>());
  const renderCallIdsRef = useRef(new Map<number, number>());
  const renderedPagesRef = useRef(new Set<number>());
  const suppressClickUntilRef = useRef(0);
  const endGestureRef = useRef<(() => void) | null>(null);
  const zoomFactorRef = useRef(DEFAULT_ZOOM);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [pageAspect, setPageAspect] = useState<Record<number, number>>({});
  const [pageMetrics, setPageMetrics] = useState<Record<number, PageMetrics>>({});
  const [isDragging, setIsDragging] = useState(false);
  const [visiblePage, setVisiblePage] = useState(1);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [zoomFactor, setZoomFactor] = useState(DEFAULT_ZOOM);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    zoomFactorRef.current = zoomFactor;
  }, [zoomFactor]);

  const fieldsByPage = useMemo(() => {
    const map = new Map<number, FieldEntry[]>();
    fields.forEach((field, index) => {
      const list = map.get(field.page) ?? [];
      list.push({ field, index });
      map.set(field.page, list);
    });
    return map;
  }, [fields]);

  // See fieldOrdinals: shared with the wizard's field list.
  const ordinalByIndex = useMemo(() => fieldOrdinals(fields), [fields]);

  const fieldsOnVisiblePage = useMemo(
    () => fieldsByPage.get(visiblePage) ?? [],
    [fieldsByPage, visiblePage]
  );

  const renderPage = useCallback(async (pageNumber: number) => {
    const callId = (renderCallIdsRef.current.get(pageNumber) ?? 0) + 1;
    renderCallIdsRef.current.set(pageNumber, callId);
    const priorTask = renderTasksRef.current.get(pageNumber);
    if (priorTask) {
      priorTask.cancel();
      try {
        await priorTask.promise;
      } catch {
        // Ignore cancellation errors
      } finally {
        if (renderTasksRef.current.get(pageNumber) === priorTask) {
          renderTasksRef.current.delete(pageNumber);
        }
      }
    }
    const pdf = pdfRef.current;
    const canvas = canvasRefs.current.get(pageNumber);
    const stage = stageRef.current;
    if (!pdf || !canvas || !stage) return;
    const page = await pdf.getPage(pageNumber);
    if (renderCallIdsRef.current.get(pageNumber) !== callId) return;

    const baseViewport = page.getViewport({ scale: 1 });
    // `clientWidth` includes the stage's own left/right padding, but the
    // page wrapper renders *inside* that padding -- fitting to the raw
    // clientWidth left the canvas ~16px wider than the actual available
    // space, which is exactly what a "100%" zoom showing a horizontal
    // scrollbar looked like. Subtract the real padding so 100% == no
    // horizontal overflow.
    const stageStyle = getComputedStyle(stage);
    const horizontalPadding =
      parseFloat(stageStyle.paddingLeft || '0') + parseFloat(stageStyle.paddingRight || '0');
    const stageWidth = stage.clientWidth - horizontalPadding || baseViewport.width;
    setContainerWidth((current) => (current === stageWidth ? current : stageWidth));
    const fitScale = stageWidth / baseViewport.width;
    const scale = Math.min(fitScale * zoomFactorRef.current, 5);
    const viewport = page.getViewport({ scale });
    const context = canvas.getContext('2d');
    if (!context) return;

    // Render the bitmap at the screen's real pixel density (Retina = 2x):
    // a canvas sized only in CSS pixels gets upscaled by the browser and
    // looks blurry. Layout (style size, pageMetrics, field positions) stays
    // in CSS pixels. Capped so a high zoom on a dense screen never exceeds
    // iOS Safari's ~16.7M-pixel canvas limit (which renders blank instead).
    const MAX_CANVAS_PIXELS = 16_000_000;
    const ratio = Math.min(
      window.devicePixelRatio || 1,
      Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height))
    );
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    context.clearRect(0, 0, canvas.width, canvas.height);
    const renderTask = page.render({
      canvas,
      canvasContext: context,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    });
    renderTasksRef.current.set(pageNumber, renderTask);
    try {
      await renderTask.promise;
    } catch (err) {
      const isCancelled =
        err instanceof Error &&
        (err.name === 'RenderingCancelledException' || err.message === 'Rendering cancelled');
      if (!isCancelled) throw err;
    } finally {
      if (renderTasksRef.current.get(pageNumber) === renderTask) {
        renderTasksRef.current.delete(pageNumber);
      }
    }
    if (renderCallIdsRef.current.get(pageNumber) !== callId) return;
    renderedPagesRef.current.add(pageNumber);
    setPageMetrics((current) => ({
      ...current,
      [pageNumber]: { widthPx: viewport.width, heightPx: viewport.height },
    }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const loadPdf = async () => {
      setLoading(true);
      setError(null);
      setPageCount(null);
      setPageAspect({});
      setPageMetrics({});
      setVisiblePage(1);
      setSelectedIndex(null);
      setZoomFactor(DEFAULT_ZOOM);
      canvasRefs.current.clear();
      overlayRefs.current.clear();
      pageWrapperRefs.current.clear();
      renderedPagesRef.current.clear();
      try {
        const data = await file.arrayBuffer();
        void pdfRef.current?.cleanup();
        const task = getDocument({ data });
        const pdf = await task.promise;
        if (cancelled) {
          task.destroy();
          return;
        }
        pdfRef.current = pdf;
        setPageCount(pdf.numPages);

        // Cheap metadata-only pass (no rasterizing) so every page's wrapper
        // can reserve its correct height up front via CSS aspect-ratio --
        // avoids the scrollbar/layout jumping around as pages lazily render.
        const aspects: Record<number, number> = {};
        await Promise.all(
          Array.from({ length: pdf.numPages }, async (_, i) => {
            const pageNumber = i + 1;
            const page = await pdf.getPage(pageNumber);
            const viewport = page.getViewport({ scale: 1 });
            aspects[pageNumber] = viewport.height / viewport.width;
          })
        );
        if (!cancelled) setPageAspect(aspects);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Unable to read PDF preview');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    loadPdf();
    const renderTasks = renderTasksRef.current;
    return () => {
      cancelled = true;
      for (const task of renderTasks.values()) task.cancel();
      renderTasks.clear();
      void pdfRef.current?.cleanup();
      pdfRef.current = null;
    };
  }, [file]);

  // Lazy-render pages as they scroll near the visible area: the wizard's
  // PDF pane when it scrolls on its own (`scrollRoot`, wide screens), else
  // the viewport (`root: null`, phones -- the page itself scrolls).
  useEffect(() => {
    if (!stageRef.current || !pageCount) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.page);
          if (!pageNumber) continue;
          if (entry.isIntersecting && !renderedPagesRef.current.has(pageNumber)) {
            renderedPagesRef.current.add(pageNumber);
            renderPage(pageNumber);
          }
        }
      },
      { root: scrollRoot, rootMargin: RENDER_ROOT_MARGIN }
    );
    for (const el of pageWrapperRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [pageCount, renderPage, scrollRoot]);

  // Which page is "visible" (drives the page readout + the "Chọn vị trí ký"
  // target page). Measured against the REAL visible area -- below the sticky
  // header/toolbar, inside the window. It used to reuse the lazy-render
  // observer above, whose 800px rootMargin made every short (landscape) page
  // count as 100% visible, so page 1 always won and the last page could
  // never become the current one.
  useEffect(() => {
    if (!pageCount) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rootRect = scrollRoot?.getBoundingClientRect();
      const viewTop = rootRect ? rootRect.top : topInset;
      const viewBottom = rootRect ? rootRect.bottom : window.innerHeight;
      // Scrolled all the way down: the last page that shows at all is the
      // one being looked at, even if it can't fill most of the screen.
      const atBottom = scrollRoot
        ? scrollRoot.clientHeight + scrollRoot.scrollTop >= scrollRoot.scrollHeight - 2
        : window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      let bestPage = 0;
      let bestVisible = 0;
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const el = pageWrapperRefs.current.get(pageNumber);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const visible = Math.min(rect.bottom, viewBottom) - Math.max(rect.top, viewTop);
        if (visible <= 0) continue;
        if (atBottom || visible > bestVisible) {
          bestVisible = visible;
          bestPage = pageNumber;
        }
      }
      if (bestPage > 0) setVisiblePage((current) => (current === bestPage ? current : bestPage));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    schedule();
    const scrollTarget: HTMLElement | Window = scrollRoot ?? window;
    scrollTarget.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      scrollTarget.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [pageCount, pageMetrics, zoomFactor, topInset, scrollRoot]);

  // The render scale is derived from container width (see renderPage above),
  // so already-rendered pages need re-rasterizing when the container resizes.
  useEffect(() => {
    if (!stageRef.current) return;
    const observer = new ResizeObserver(() => {
      for (const pageNumber of renderedPagesRef.current) renderPage(pageNumber);
    });
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [renderPage]);

  // Re-rasterize every already-rendered page at the new zoom level. Skipped
  // on mount (nothing rendered yet at that point) via the empty-set check.
  useEffect(() => {
    if (renderedPagesRef.current.size === 0) return;
    for (const pageNumber of renderedPagesRef.current) renderPage(pageNumber);
  }, [zoomFactor, renderPage]);

  const updateField = useCallback(
    (index: number, next: SignatureFieldProps) => {
      onFieldsChange((current) => current.map((field, i) => (i === index ? next : field)));
    },
    [onFieldsChange]
  );

  // Safety net: the new box is placed inside the visible part of the page
  // (below), so normally nothing scrolls -- but if the layout shifts right
  // after adding (e.g. a pane resizing), it is brought back into view.
  const pendingScrollIndexRef = useRef<number | null>(null);

  /** The part of `pageNumber` currently on screen, as fractions of its
   * height -- measured against the same visible area as the "current page"
   * readout (the PDF pane on wide screens, else the window below
   * `topInset`). `undefined` if the page isn't laid out or not in view. */
  const visibleBandOf = useCallback(
    (pageNumber: number): VisibleBand | undefined => {
      const el = pageWrapperRefs.current.get(pageNumber);
      if (!el) return undefined;
      const rect = el.getBoundingClientRect();
      if (rect.height <= 0) return undefined;
      const rootRect = scrollRoot?.getBoundingClientRect();
      const viewTop = rootRect ? rootRect.top : topInset;
      const viewBottom = rootRect ? rootRect.bottom : window.innerHeight;
      const top = (Math.max(rect.top, viewTop) - rect.top) / rect.height;
      const bottom = (Math.min(rect.bottom, viewBottom) - rect.top) / rect.height;
      return bottom > top ? { top, bottom } : undefined;
    },
    [scrollRoot, topInset]
  );

  const addFieldToPage = useCallback(() => {
    const metrics = pageMetrics[visiblePage];
    if (disabled || !metrics) return;
    // Lands in the part of the page the user is looking at (not a fixed
    // slot near the page bottom, which made the view jump down).
    const next = makeAvailableField(
      visiblePage,
      fieldsOnVisiblePage.map(({ field }) => field),
      visibleBandOf(visiblePage)
    );
    onFieldsChange((current) => [...current, next]);
    setSelectedIndex(fields.length);
    pendingScrollIndexRef.current = fields.length;
  }, [
    disabled,
    pageMetrics,
    visiblePage,
    fieldsOnVisiblePage,
    fields.length,
    onFieldsChange,
    visibleBandOf,
  ]);

  // Waits until the layout stops changing (each re-render updates
  // `containerWidth`/`pageMetrics`, re-running this effect and restarting the
  // timer), then makes sure the new box is in view. `nearest`: a box that is
  // already visible -- the normal case -- doesn't move the view at all.
  useEffect(() => {
    const index = pendingScrollIndexRef.current;
    if (index == null || !fields[index]) return;
    const id = window.setTimeout(() => {
      pendingScrollIndexRef.current = null;
      stageRef.current
        ?.querySelector(`[data-field-index="${index}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 250);
    return () => window.clearTimeout(id);
  }, [fields, pageMetrics, containerWidth]);

  const removeField = useCallback(
    (index: number) => {
      if (disabled) return;
      onFieldsChange((current) => current.filter((_, i) => i !== index));
      setSelectedIndex(null);
    },
    [disabled, onFieldsChange]
  );

  // Clicking the page (not a box) only deselects. Boxes move by drag only;
  // the click right after a drag/resize is swallowed (suppressClickUntil).
  const handlePageOverlayClick = useCallback(() => {
    if (disabled) return;
    if (Date.now() < suppressClickUntilRef.current) return;
    setSelectedIndex(null);
  }, [disabled]);

  const startGesture = useCallback(
    (event: React.PointerEvent<HTMLElement>, index: number, mode: 'move' | 'resize') => {
      const field = fields[index];
      const metrics = field ? pageMetrics[field.page] : undefined;
      const overlay = field ? overlayRefs.current.get(field.page) : undefined;
      if (disabled || !field || !metrics || !overlay) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClickUntilRef.current = Date.now() + 250;
      setSelectedIndex(index);
      setIsDragging(true);

      const pointerId = event.pointerId;
      const bounds = overlay.getBoundingClientRect();
      const grab =
        mode === 'move'
          ? {
              x: event.clientX - (bounds.left + field.xRatio * metrics.widthPx),
              y: event.clientY - (bounds.top + field.yRatio * metrics.heightPx),
            }
          : { x: 0, y: 0 };

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        moveEvent.preventDefault();
        const live = overlay.getBoundingClientRect();
        if (mode === 'move') {
          updateField(index, {
            ...field,
            xRatio: clamp(
              (moveEvent.clientX - live.left - grab.x) / metrics.widthPx,
              0,
              Math.max(1 - field.widthRatio, 0)
            ),
            yRatio: clamp(
              (moveEvent.clientY - live.top - grab.y) / metrics.heightPx,
              0,
              Math.max(1 - field.heightRatio, 0)
            ),
          });
          return;
        }
        updateField(index, {
          ...field,
          widthRatio: clamp(
            (moveEvent.clientX - live.left) / metrics.widthPx - field.xRatio,
            MIN_WIDTH_RATIO,
            Math.max(1 - field.xRatio, MIN_WIDTH_RATIO)
          ),
          heightRatio: clamp(
            (moveEvent.clientY - live.top) / metrics.heightPx - field.yRatio,
            MIN_HEIGHT_RATIO,
            Math.min(MAX_HEIGHT_RATIO, Math.max(1 - field.yRatio, MIN_HEIGHT_RATIO))
          ),
        });
      };

      const endGesture = (endEvent?: Event) => {
        if (endEvent instanceof PointerEvent && endEvent.pointerId !== pointerId) return;
        setIsDragging(false);
        suppressClickUntilRef.current = Date.now() + 250;
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', endGesture);
        window.removeEventListener('pointercancel', endGesture);
        window.removeEventListener('blur', endGesture);
        endGestureRef.current = null;
      };

      endGestureRef.current = () => endGesture();
      window.addEventListener('pointermove', handleMove, { passive: false });
      window.addEventListener('pointerup', endGesture);
      window.addEventListener('pointercancel', endGesture);
      window.addEventListener('blur', endGesture);
    },
    [disabled, fields, pageMetrics, updateField]
  );

  useEffect(() => () => endGestureRef.current?.(), []);

  const scrollToPage = useCallback(
    (pageNumber: number) => {
      if (!pageCount) return;
      const safe = clamp(Math.trunc(pageNumber), 1, pageCount);
      const el = pageWrapperRefs.current.get(safe);
      if (!el) return;
      // Explicit vertical scroll (not scrollIntoView) so the page top lands
      // just below the sticky header/toolbar (window) or the pane's top
      // edge (scrollRoot), and the stage's own horizontal scroll position
      // is left alone.
      if (scrollRoot) {
        const top =
          el.getBoundingClientRect().top -
          scrollRoot.getBoundingClientRect().top +
          scrollRoot.scrollTop -
          8;
        scrollRoot.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        return;
      }
      const top = el.getBoundingClientRect().top + window.scrollY - topInset - 8;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    },
    [pageCount, topInset, scrollRoot]
  );

  const zoomOut = useCallback(() => {
    setZoomFactor((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100));
  }, []);

  const zoomIn = useCallback(() => {
    setZoomFactor((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100));
  }, []);

  const registerWrapperRef = useCallback((pageNumber: number, el: HTMLDivElement | null) => {
    if (el) pageWrapperRefs.current.set(pageNumber, el);
    else pageWrapperRefs.current.delete(pageNumber);
  }, []);

  const registerCanvasRef = useCallback((pageNumber: number, el: HTMLCanvasElement | null) => {
    if (el) canvasRefs.current.set(pageNumber, el);
    else canvasRefs.current.delete(pageNumber);
  }, []);

  const registerOverlayRef = useCallback((pageNumber: number, el: HTMLDivElement | null) => {
    if (el) overlayRefs.current.set(pageNumber, el);
    else overlayRefs.current.delete(pageNumber);
  }, []);

  const pageNumbers = useMemo(
    () => (pageCount ? Array.from({ length: pageCount }, (_, i) => i + 1) : []),
    [pageCount]
  );

  // Mirror display state up to the parent, which now owns the toolbar UI
  // that shows/controls it (see the module comment).
  useEffect(() => {
    onVisiblePageChange?.(visiblePage);
  }, [visiblePage, onVisiblePageChange]);
  useEffect(() => {
    onPageCountChange?.(pageCount);
  }, [pageCount, onPageCountChange]);
  useEffect(() => {
    onZoomFactorChange?.(zoomFactor);
  }, [zoomFactor, onZoomFactorChange]);
  useEffect(() => {
    // No per-page cap any more: adding only needs the visible page rendered.
    const canAdd = !disabled && Boolean(pageMetrics[visiblePage]);
    onCanAddFieldChange?.(canAdd);
  }, [disabled, pageMetrics, visiblePage, onCanAddFieldChange]);

  useImperativeHandle(
    ref,
    () => ({
      zoomIn,
      zoomOut,
      addField: addFieldToPage,
      goToPage: scrollToPage,
      focusField: (index: number) => {
        if (!fields[index]) return;
        setSelectedIndex(index);
        stageRef.current
          ?.querySelector(`[data-field-index="${index}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      },
      removeField,
    }),
    [zoomIn, zoomOut, addFieldToPage, scrollToPage, removeField, fields]
  );

  return (
    <div className="space-y-2">
      {/* Only while the preview is loading -- the always-on "scroll to see
          pages" / "no field yet" lines and the "click where you want the
          box" hint were dropped (per explicit request) so the PDF is all
          this pane shows. */}
      {loading && <p className="text-xs italic text-gray-600">{t('sign.renderingPreview')}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div
        ref={stageRef}
        // Light gray stage (was near-black, which felt heavy next to the
        // light app UI) -- each white page gets a shadow + hairline ring
        // (PdfPageBlock) so its edges stay obvious against the stage,
        // especially once zoomed in, like light-mode PDF viewers do. Grows
        // to its natural height; the wizard's PDF pane (wide screens) or the
        // page (phones) does the vertical scrolling. `overflow-x-auto`:
        // zoomed past 100% a page is wider than the stage; scroll it
        // sideways here instead of letting it spill over the signer pane.
        className="relative mx-auto w-full max-w-none space-y-4 overflow-x-auto rounded-xl border border-border-subtle bg-gray-100 p-2"
      >
        {pageNumbers.map((pageNumber) => (
          <PdfPageBlock
            key={pageNumber}
            pageNumber={pageNumber}
            aspect={pageAspect[pageNumber]}
            widthPx={containerWidth ? containerWidth * zoomFactor : undefined}
            metrics={pageMetrics[pageNumber]}
            fieldsHere={fieldsByPage.get(pageNumber) ?? []}
            ordinalByIndex={ordinalByIndex}
            selectedIndex={selectedIndex}
            isDragging={isDragging}
            disabled={disabled}
            registerWrapperRef={registerWrapperRef}
            registerCanvasRef={registerCanvasRef}
            registerOverlayRef={registerOverlayRef}
            onOverlayClick={handlePageOverlayClick}
            onFieldPointerDown={startGesture}
            onFieldSelect={setSelectedIndex}
            onFieldRemove={removeField}
          />
        ))}
      </div>
    </div>
  );
}

const SignaturePlacement = forwardRef(SignaturePlacementInner);
export default SignaturePlacement;

function PdfPageBlock({
  pageNumber,
  aspect,
  widthPx,
  metrics,
  fieldsHere,
  ordinalByIndex,
  selectedIndex,
  isDragging,
  disabled,
  registerWrapperRef,
  registerCanvasRef,
  registerOverlayRef,
  onOverlayClick,
  onFieldPointerDown,
  onFieldSelect,
  onFieldRemove,
}: {
  pageNumber: number;
  aspect: number | undefined;
  /** Explicit pixel width = stage width × zoom -- lets the wrapper (and its
   * CSS `aspect-ratio`-derived height) grow past 100% when zoomed in, rather
   * than clipping the (wider) rendered canvas. Falls back to `w-full` via
   * the className below until the stage has been measured at least once. */
  widthPx: number | undefined;
  metrics: PageMetrics | undefined;
  fieldsHere: FieldEntry[];
  /** Document-wide 1-based number per field index (see `ordinalByIndex`). */
  ordinalByIndex: number[];
  selectedIndex: number | null;
  isDragging: boolean;
  disabled: boolean | undefined;
  registerWrapperRef: (pageNumber: number, el: HTMLDivElement | null) => void;
  registerCanvasRef: (pageNumber: number, el: HTMLCanvasElement | null) => void;
  registerOverlayRef: (pageNumber: number, el: HTMLDivElement | null) => void;
  onOverlayClick: () => void;
  onFieldPointerDown: (
    event: React.PointerEvent<HTMLElement>,
    index: number,
    mode: 'move' | 'resize'
  ) => void;
  onFieldSelect: (index: number) => void;
  onFieldRemove: (index: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      ref={(el) => registerWrapperRef(pageNumber, el)}
      data-page={pageNumber}
      className="relative mx-auto w-full bg-white shadow-md ring-1 ring-black/5"
      style={{
        aspectRatio: aspect ? `1 / ${aspect}` : undefined,
        width: widthPx,
      }}
    >
      <div
        className="relative h-full w-full"
        onClick={onOverlayClick}
      >
        <canvas
          ref={(el) => registerCanvasRef(pageNumber, el)}
          className="block h-full w-full select-none"
          aria-label={t('sign.aria.pdfPreview')}
        />
        {metrics && (
          <div
            ref={(el) => registerOverlayRef(pageNumber, el)}
            className="pointer-events-none absolute left-0 top-0"
            style={{ width: metrics.widthPx, height: metrics.heightPx }}
          >
            {fieldsHere.map(({ field, index }) => {
              const box = {
                leftPx: field.xRatio * metrics.widthPx,
                topPx: field.yRatio * metrics.heightPx,
                widthPx: field.widthRatio * metrics.widthPx,
                heightPx: field.heightRatio * metrics.heightPx,
              };
              const isSelected = selectedIndex === index;
              const ordinal = ordinalByIndex[index] ?? index + 1;
              // Small boxes (min size, low zoom) only fit the icon + "#N".
              const compact = box.widthPx < 150 || box.heightPx < 44;
              // Near the top edge of the page, the toolbar goes below the
              // box instead so it isn't clipped by the page/canvas above.
              const toolbarBelow = box.topPx < 28;
              return (
                <div
                  key={`field-${index}`}
                  data-field-index={index}
                  role="button"
                  tabIndex={disabled ? -1 : 0}
                  aria-label={t('sign.aria.signaturePlacement')}
                  aria-pressed={isSelected}
                  className={`pointer-events-auto absolute left-0 top-0 touch-none rounded-md border-2 border-dashed transition-colors ${
                    // Near-opaque fill so the PDF text underneath doesn't
                    // bleed through and make the box's own label unreadable.
                    isSelected
                      ? 'z-10 border-primary bg-surface-soft-strong/95 shadow-lg shadow-primary/20'
                      : 'border-primary/70 bg-surface-soft/90 hover:border-primary hover:bg-surface-soft-strong/95'
                  } ${disabled ? 'cursor-not-allowed' : isDragging && isSelected ? 'cursor-grabbing' : 'cursor-grab'}`}
                  style={{
                    width: box.widthPx,
                    height: box.heightPx,
                    transform: `translate(${box.leftPx}px, ${box.topPx}px)`,
                  }}
                  onPointerDown={(event) => onFieldPointerDown(event, index, 'move')}
                  onClick={(event) => {
                    event.stopPropagation();
                    onFieldSelect(index);
                  }}
                >
                  <div className="pointer-events-none flex h-full w-full flex-col items-center justify-center gap-0.5 overflow-hidden px-1 text-center text-primary-strong">
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold leading-tight">
                      <Icon icon="lucide:pen-line" className="h-3.5 w-3.5 shrink-0" />
                      {compact ? `#${ordinal}` : t('sign.fieldLabel', { n: ordinal })}
                    </span>
                    {!compact && (
                      <span className="whitespace-nowrap text-[10px] leading-tight text-primary-strong/70">
                        {t('sign.fieldSubLabel')}
                      </span>
                    )}
                  </div>
                  {!disabled && isSelected && (
                    // Toolbar riding on the selected box. The drag label has
                    // no handler of its own: its pointerdown bubbles to the
                    // box, so grabbing it moves the box like the box itself.
                    <div
                      className={`absolute left-0 flex w-max min-w-full items-center justify-between gap-2 ${
                        toolbarBelow ? 'top-full mt-1.5' : 'bottom-full mb-1.5'
                      }`}
                    >
                      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-primary px-1.5 py-0.5 text-[11px] font-semibold text-white shadow-sm">
                        <Icon icon="lucide:grip-vertical" className="h-3 w-3" />
                        {t('sign.dragToMove')}
                      </span>
                      <button
                        type="button"
                        aria-label={t('sign.removeField')}
                        title={t('sign.removeField')}
                        className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-md border border-red-500 bg-white px-1.5 py-0.5 text-[11px] font-semibold text-red-600 shadow-sm transition-colors hover:bg-red-600 hover:text-white"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          onFieldRemove(index);
                        }}
                      >
                        <Icon icon="lucide:trash-2" className="h-3 w-3" />
                        {t('sign.removeFieldShort')}
                      </button>
                    </div>
                  )}
                  {!disabled && (
                    <div
                      role="presentation"
                      aria-hidden="true"
                      title={t('sign.aria.resizeField')}
                      className="absolute -bottom-1.5 -right-1.5 flex h-4 w-4 cursor-nwse-resize items-center justify-center rounded-sm border-2 border-white bg-primary text-white shadow-md hover:bg-primary-strong"
                      onPointerDown={(event) => onFieldPointerDown(event, index, 'resize')}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Icon icon="lucide:move-diagonal-2" className="pointer-events-none h-2.5 w-2.5" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
