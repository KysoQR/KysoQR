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
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import {
  MAX_HEIGHT_RATIO,
  MIN_HEIGHT_RATIO,
  MIN_WIDTH_RATIO,
  clamp,
  makeAvailableField,
  type SignatureFieldProps,
} from '@/lib/domain/SignatureField';

if (!GlobalWorkerOptions.workerSrc) {
  GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
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
 * targets whichever page is currently most visible while scrolling, and the
 * click that places it can land on any page (not just the one it was
 * created on, an explicit product decision this session).
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
};

export type SignaturePlacementHandle = {
  zoomIn: () => void;
  zoomOut: () => void;
  addField: () => void;
  goToPage: (page: number) => void;
};

type PageMetrics = { widthPx: number; heightPx: number };
type PdfPage = Awaited<ReturnType<PDFDocumentProxy['getPage']>>;
type PdfRenderTask = ReturnType<PdfPage['render']>;
type FieldEntry = { field: SignatureFieldProps; index: number };

const RENDER_ROOT_MARGIN = '800px 0px';
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.25;

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
  const visibilityRatiosRef = useRef(new Map<number, number>());
  const suppressClickUntilRef = useRef(0);
  const endGestureRef = useRef<(() => void) | null>(null);
  const zoomFactorRef = useRef(0.8);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [pageAspect, setPageAspect] = useState<Record<number, number>>({});
  const [pageMetrics, setPageMetrics] = useState<Record<number, PageMetrics>>({});
  const [isDragging, setIsDragging] = useState(false);
  const [visiblePage, setVisiblePage] = useState(1);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [isPlacingNew, setIsPlacingNew] = useState(false);
  const [zoomFactor, setZoomFactor] = useState(0.8);
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

  // 1-based number shown on each box, counted across the whole document
  // (page order, then creation order within a page) so it matches the
  // wizard's total "N ô ký" counter. Deliberately not by on-page position:
  // that would renumber boxes while one is being dragged up or down.
  const ordinalByIndex = useMemo(() => {
    const ordinals: number[] = [];
    let next = 1;
    [...fieldsByPage.keys()]
      .sort((a, b) => a - b)
      .forEach((page) => {
        for (const { index } of fieldsByPage.get(page) ?? []) ordinals[index] = next++;
      });
    return ordinals;
  }, [fieldsByPage]);

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

    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    context.clearRect(0, 0, viewport.width, viewport.height);
    const renderTask = page.render({ canvas, canvasContext: context, viewport });
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
      setIsPlacingNew(false);
      setZoomFactor(0.8);
      canvasRefs.current.clear();
      overlayRefs.current.clear();
      pageWrapperRefs.current.clear();
      renderedPagesRef.current.clear();
      visibilityRatiosRef.current.clear();
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

  // Lazy-render pages as they scroll near the viewport, and track which page
  // is most visible (drives the page readout + "Thêm ô chữ ký" target).
  useEffect(() => {
    if (!stageRef.current || !pageCount) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.page);
          if (!pageNumber) continue;
          visibilityRatiosRef.current.set(pageNumber, entry.intersectionRatio);
          if (entry.isIntersecting && !renderedPagesRef.current.has(pageNumber)) {
            renderedPagesRef.current.add(pageNumber);
            renderPage(pageNumber);
          }
        }
        let bestPage = 0;
        let bestRatio = 0;
        for (const [pageNumber, ratio] of visibilityRatiosRef.current) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestPage = pageNumber;
          }
        }
        if (bestPage > 0) {
          setVisiblePage((current) => (current === bestPage ? current : bestPage));
        }
      },
      // `root: null` (viewport) -- the stage no longer scrolls internally,
      // the page itself does (see SigningWizard.tsx's single page scroll).
      { root: null, rootMargin: RENDER_ROOT_MARGIN, threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    for (const el of pageWrapperRefs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [pageCount, renderPage]);

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

  const centredAt = useCallback(
    (
      base: SignatureFieldProps,
      xPx: number,
      yPx: number,
      metrics: PageMetrics
    ): SignatureFieldProps => ({
      ...base,
      xRatio: clamp(
        xPx / metrics.widthPx - base.widthRatio / 2,
        0,
        Math.max(1 - base.widthRatio, 0)
      ),
      yRatio: clamp(
        yPx / metrics.heightPx - base.heightRatio / 2,
        0,
        Math.max(1 - base.heightRatio, 0)
      ),
    }),
    []
  );

  // The default slot is near the bottom of the page, often below the fold
  // -- without this the new box can land where the user isn't looking.
  const pendingScrollIndexRef = useRef<number | null>(null);

  const addFieldToPage = useCallback(() => {
    const metrics = pageMetrics[visiblePage];
    if (disabled || !metrics) return;
    const next = makeAvailableField(
      visiblePage,
      fieldsOnVisiblePage.map(({ field }) => field)
    );
    onFieldsChange((current) => [...current, next]);
    setSelectedIndex(fields.length);
    setIsPlacingNew(true);
    pendingScrollIndexRef.current = fields.length;
  }, [disabled, pageMetrics, visiblePage, fieldsOnVisiblePage, fields.length, onFieldsChange]);

  // Placing the first box also opens the wizard's left column, which narrows
  // the stage and re-renders every page -- scrolling right away would aim at
  // where the box *was*. So the scroll waits until the layout stops changing
  // (each re-render updates `containerWidth`/`pageMetrics`, re-running this
  // effect and restarting the timer), then scrolls to the box element itself.
  useEffect(() => {
    const index = pendingScrollIndexRef.current;
    if (index == null || !fields[index]) return;
    const id = window.setTimeout(() => {
      pendingScrollIndexRef.current = null;
      stageRef.current
        ?.querySelector(`[data-field-index="${index}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 250);
    return () => window.clearTimeout(id);
  }, [fields, pageMetrics, containerWidth]);

  const removeField = useCallback(
    (index: number) => {
      if (disabled) return;
      onFieldsChange((current) => current.filter((_, i) => i !== index));
      setSelectedIndex(null);
      setIsPlacingNew(false);
    },
    [disabled, onFieldsChange]
  );

  const handlePageOverlayClick = useCallback(
    (pageNumber: number, event: React.MouseEvent<HTMLDivElement>) => {
      const metrics = pageMetrics[pageNumber];
      const overlay = overlayRefs.current.get(pageNumber);
      if (disabled || !metrics || !overlay) return;
      if (Date.now() < suppressClickUntilRef.current) return;
      if (!isPlacingNew) {
        setSelectedIndex(null);
        return;
      }
      const target = selectedIndex ?? fieldsByPage.get(pageNumber)?.[0]?.index ?? null;
      setIsPlacingNew(false);
      if (target == null || !fields[target]) return;
      const bounds = overlay.getBoundingClientRect();
      const xPx = clamp(event.clientX - bounds.left, 0, metrics.widthPx);
      const yPx = clamp(event.clientY - bounds.top, 0, metrics.heightPx);
      // Reassign `page` too, not just x/y -- lets a box created while one
      // page was in view be placed on whichever page the user scrolls to
      // and clicks next (explicit product decision, see the module comment).
      updateField(target, { ...centredAt(fields[target], xPx, yPx, metrics), page: pageNumber });
      setSelectedIndex(target);
    },
    [
      disabled,
      pageMetrics,
      isPlacingNew,
      selectedIndex,
      fieldsByPage,
      fields,
      updateField,
      centredAt,
    ]
  );

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
      pageWrapperRefs.current.get(safe)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [pageCount]
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
    }),
    [zoomIn, zoomOut, addFieldToPage, scrollToPage]
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
        <span className={isPlacingNew && !loading ? 'font-medium text-primary-strong' : 'italic'}>
          {loading
            ? t('sign.renderingPreview')
            : isPlacingNew
              ? t('sign.placingNewFieldHint')
              : t('sign.clickOrDrag')}
        </span>
        {fields.length === 0 && (
          <span className="text-text-muted">{t('sign.addFirstFieldHint')}</span>
        )}
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div
        ref={stageRef}
        // Dark background (was white) -- makes each white PDF page's own
        // edges/boundaries visually obvious against the surrounding stage,
        // especially once zoomed in and there's real empty space around/
        // between pages (matches the convention most PDF viewers use). No
        // longer scroll-contained -- grows to its natural height and scrolls
        // along with the page (see SigningWizard.tsx's single page scroll).
        className="relative mx-auto w-full max-w-none space-y-4 rounded-md border border-gray-700 bg-neutral-900 p-2"
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
  onOverlayClick: (pageNumber: number, event: React.MouseEvent<HTMLDivElement>) => void;
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
      className="relative mx-auto w-full"
      style={{
        aspectRatio: aspect ? `1 / ${aspect}` : undefined,
        width: widthPx,
      }}
    >
      <div
        className="relative h-full w-full"
        onClick={(event) => onOverlayClick(pageNumber, event)}
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
