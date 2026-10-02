'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import Header from '@/components/Header';
import { HeaderSteps } from '@/components/signing/HeaderSteps';
import { StickyAnchorColumn } from '@/components/signing/StickyAnchorColumn';
import { SigningCard } from '@/components/signing/SigningCard';
import { SigningStepHeader } from '@/components/signing/SigningStepHeader';
import { ButtonSpinner, InlineSpinner } from '@/components/signing/Spinners';
import { QRErrorBoundary } from '@/components/signing/QRErrorBoundary';
import { ExpiresIn } from '@/components/signing/ExpiresIn';
import { MAX_SIGN_UPLOAD_SIZE_MB, formatFileSize } from '@/components/signing/constants';
import QR from '@/components/QR';
import SignaturePlacement, {
  ZOOM_MIN,
  ZOOM_MAX,
  type SignaturePlacementHandle,
} from '@/components/SignaturePlacement';
import {
  SignerConfigPanel,
  isCasSignerConfigValid,
  type CasSignerConfigValue,
} from '@/components/SignerConfigPanel';
import { DownloadReminderModal } from '@/components/DownloadReminderModal';
import { SignRequestErrorModal } from '@/components/SignRequestErrorModal';
import { VerificationPopup } from '@/components/VerificationPopup';
import { SigningRoundResult } from '@/components/SigningRoundResult';
import { SignatureHistorySidebar } from '@/components/SignatureHistorySidebar';
import type { SignatureFieldProps } from '@/lib/domain/SignatureField';
import { parseJsonSafely } from '@/lib/http';
import { addRecentSignature } from '@/lib/recentSignatures';
import { downloadSignedPdfBlob as fetchSignedPdfBytes, signedFileName } from '@/lib/downloadSignedPdf';
import { lookupSigningRound } from '@/lib/signingRoundLookup';
import type { SigningRoundDetail } from '@/lib/cas/CasProvider';
import type { VerificationResult } from '@/lib/verification/verifyPdfSignatures';
import { CAS_ID_VIDEO_GUIDE_ID, CasIdVideoGuide } from './signing/CasIdVideoGuide';
import { ScrollCue } from './ScrollCue';
import Footer from './Footer';

/**
 * Signing wizard — UI/UX ported from x-sign-web (IntentSigningPage +
 * UploadWithPlacementStep + QrStep + DoneStep + DownloadReminderModal),
 * adapted to the new stateless single-request flow: no separate "create
 * intent" / "request permission" step, no IDKIT auto-fill, no
 * continue-signing / signature-history-sidebar (all out of scope for v1).
 *
 * `initialFile` seeds the placement step directly with a file the user
 * already dropped on the home page (HomeLanding) — no separate upload
 * round-trip exists in this architecture, so this is a plain prop, not a
 * navigation/documentId handoff.
 */

type Step = 'upload' | 'scan' | 'done';
const STEP_ORDER: Step[] = ['upload', 'scan', 'done'];

/**
 * The 3 form/PDF/history columns "anchor" via `position: sticky; top:
 * stickyOffset` -- NOT `bottom`, which was tried first and turned out to be
 * a dead end: verified with an isolated Playwright test that `bottom`-sticky
 * never engages at all for a column whose in-flow position starts already
 * above the fold (true here, since all 3 columns start at the same row right
 * below the header) -- `bottom` only ever catches an element that would
 * otherwise scroll off the *bottom* of the viewport, never one scrolling off
 * the *top*, so it was a no-op the entire time, not merely "close but a bit
 * off". `top`-sticky is the one that actually works for this layout: a
 * column sticks once scrolled to `stickyOffset` and releases once the row's
 * tallest sibling's content (same "rail" height-matching trick) has scrolled
 * past. The one real limitation `top`-sticky has -- a column taller than the
 * viewport gets stuck with its own lower portion permanently hidden below
 * the fold, since a stuck element doesn't scroll internally -- is handled by
 * `StickyAnchorColumn` (components/signing/StickyAnchorColumn.tsx): such a
 * column stays visually anchored but progressively reveals its own content
 * via a scroll-driven `transform`, rather than either hiding part of it or
 * falling back to a second, separately-scrollable element (an internal
 * `overflow-y: auto` scrollbox was tried once this session, explicitly
 * rejected: "chỉ dùng 1 scroll duy nhất").
 */

const LS_KEYS = {
  signRequestId: 'kysoqr.signRequestId',
  status: 'kysoqr.status',
  identityKey: 'kysoqr.identityKey',
  identityKeyExpiresAt: 'kysoqr.identityKeyExpiresAt',
  orgIdSigned: 'kysoqr.orgIdSigned',
  documentName: 'kysoqr.documentName',
  createdAt: 'kysoqr.createdAt',
} as const;

const TERMINAL_STATUSES = new Set(['SIGNED', 'REJECTED', 'FAILED', 'EXPIRED']);

/** Terminal means "nothing left to resume" — clear immediately so a reload
 * (or just staying on the page) can start a fresh signing session right
 * away, per explicit product requirement. */
/** DevTools-console summary of every signature that did not verify as
 * SIGNED_VALID (the technical detail is in the server log). `console.warn`,
 * not `console.error`, so it never triggers Next's dev error overlay. */
function logSignatureProblems(signatures: VerificationResult[]) {
  for (const sig of signatures) {
    if (sig.status === 'SIGNED_VALID') continue;
    console.warn(`[verify] signature #${sig.position ?? '?'}: ${sig.status} -- ${sig.message}`, sig);
  }
}

function clearPersistedSession() {
  for (const key of Object.values(LS_KEYS)) window.localStorage.removeItem(key);
}

/** On reaching SIGNED specifically, everything about *this* round is done
 * except `identityKey`/`identityKeyExpiresAt`/`documentName` — kept a little
 * longer, on purpose, so "Tiếp tục ký" (continue signing) still works even
 * after a reload, up until identityKey's own ~1-day CAS expiry (or until a
 * new round actually consumes it — see handleContinueSigning). */
function clearRoundKeepPendingIdentity() {
  window.localStorage.removeItem(LS_KEYS.signRequestId);
  window.localStorage.removeItem(LS_KEYS.status);
  window.localStorage.removeItem(LS_KEYS.orgIdSigned);
  window.localStorage.removeItem(LS_KEYS.createdAt);
}

/**
 * Measures one element's rendered height via ResizeObserver, reporting it
 * through `setHeight`. Used for the step-indicator/sticky-header heights
 * below, where only the async `ResizeObserver` path is needed -- see
 * `useSyncedHeightObserver` for the 3 sticky columns, which additionally
 * need a synchronous re-measurement (that hook shares this one's hysteresis
 * logic via `useHeightReporter`, factored out below).
 */
function useHeightObserver(setHeight: (height: number) => void) {
  const observerRef = useRef<ResizeObserver | null>(null);
  const report = useHeightReporter(setHeight);
  return useCallback(
    (el: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!el) return;
      const observer = new ResizeObserver((entries) => {
        const height = entries[0]?.contentRect.height;
        if (height) report(Math.round(height));
      });
      observer.observe(el);
      observerRef.current = observer;
    },
    [report]
  );
}

/**
 * Shared hysteresis gate: reports only past a small band (>2px), not on
 * every callback -- this height feeds `StickyAnchorColumn`'s scroll-reveal
 * effect, which re-applies a `transform` the instant any of its dependencies
 * (this height included) changes at all, with no debounce. Real
 * GPU-rendered browsers can report a sub-pixel-different `contentRect.height`
 * from one reflow to the next for the exact same visual content (font
 * hinting/antialiasing -- headless/software rendering doesn't have this
 * non-determinism, which is why a real continuous jitter here never
 * reproduced under Playwright). A genuine content change (adding fields,
 * switching signer kind) is tens to hundreds of pixels, far above this band
 * -- only meaningless noise is filtered out.
 */
function useHeightReporter(setHeight: (height: number) => void) {
  const lastReportedRef = useRef<number | null>(null);
  return useCallback(
    (rounded: number) => {
      if (
        lastReportedRef.current !== null &&
        Math.abs(rounded - lastReportedRef.current) <= 2
      ) {
        return;
      }
      lastReportedRef.current = rounded;
      setHeight(rounded);
    },
    [setHeight]
  );
}

/**
 * Like `useHeightObserver`, but also exposes `measureNow`, a synchronous
 * counterpart to the async `ResizeObserver` callback, sharing the exact
 * same hysteresis gate (`useHeightReporter`) so the two can never disagree
 * about "what's already been reported." `ResizeObserver` fires *after* the
 * browser has already laid out and (about to) painted a frame -- so a
 * content-height change that happens as part of an ordinary React re-render
 * (e.g. switching Cá nhân/Doanh nghiệp, which adds/removes form fields)
 * would otherwise get painted once with a stale height-derived layout
 * decision (`StickyAnchorColumn`'s `plainSticky`/`needsScrollReveal` branch),
 * THEN corrected a frame later -- visible as a jarring pop if that correction
 * flips which branch renders, since that's a real DOM-structure change (a
 * whole wrapper div appearing/disappearing), not a CSS value smoothly
 * changing. Calling `measureNow()` from a dependency-less `useLayoutEffect`
 * (below, in the component) closes that gap for anything that changes
 * height as part of a React commit: the effect runs synchronously, before
 * paint, in the same flush as the render that changed the DOM, so by the
 * time the browser actually paints, the corrected height is already
 * committed -- the stale frame is never shown. `ResizeObserver` still does
 * the necessary work for height changes that DON'T originate from a React
 * state update (a PDF page finishing async render, a web font swap, the
 * window resizing).
 *
 * Returns `{ contentRef, measureNow }` -- an object, not a bare function
 * like `useHeightObserver` above, only ever passed to a custom `contentRef`
 * prop (`StickyAnchorColumn`), never to a native `ref={...}` attribute. That
 * distinction matters to the React Compiler's ref-safety lint
 * (`react-hooks/refs`): it's fine with a plain object property access here,
 * but flags `Object.assign`-ing `measureNow` onto the ref-callback function
 * itself as an unsafe ref access -- an earlier version of this hook tried
 * exactly that so every caller could share one signature, and had to be
 * split back into these two hooks instead.
 */
function useSyncedHeightObserver(setHeight: (height: number) => void) {
  const observerRef = useRef<ResizeObserver | null>(null);
  const elRef = useRef<HTMLDivElement | null>(null);
  const report = useHeightReporter(setHeight);

  const contentRef = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current = el;
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!el) return;
      const observer = new ResizeObserver((entries) => {
        const height = entries[0]?.contentRect.height;
        if (height) report(Math.round(height));
      });
      observer.observe(el);
      observerRef.current = observer;
    },
    [report]
  );

  const measureNow = useCallback(() => {
    const height = elRef.current?.getBoundingClientRect().height;
    if (height) report(Math.round(height));
  }, [report]);

  return { contentRef, measureNow };
}

const DEFAULT_SIGNER_CONFIG: CasSignerConfigValue = {
  signerKind: 'individual',
  identificationNumber: '',
  taxCode: '',
  organizationName: '',
  representativeName: '',
};

export function SigningWizard({
  initialFile = null,
  onBackToHome,
}: {
  initialFile?: File | null;
  onBackToHome?: () => void;
}) {
  const { t, i18n } = useTranslation();

  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(initialFile);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragCounter, setDragCounter] = useState(0);
  const [signerConfig, setSignerConfig] = useState<CasSignerConfigValue>(DEFAULT_SIGNER_CONFIG);
  const [signatureFields, setSignatureFields] = useState<SignatureFieldProps[]>([]);

  // The left column (upload + signer config) follows whether the document
  // currently has any signature field: it opens with the first one and
  // closes again once the last one is removed, handing the space back to the
  // PDF. Each time fields go from none to some, the signer-config box is
  // highlighted again as the next step. Tracked during render (not in an
  // effect) so the highlight lands in the same paint as the field.
  const hasSignatureFields = signatureFields.length > 0;
  const [hadSignatureFields, setHadSignatureFields] = useState(false);
  const [signerConfigJustRevealed, setSignerConfigJustRevealed] = useState(false);
  if (hasSignatureFields !== hadSignatureFields) {
    setHadSignatureFields(hasSignatureFields);
    setSignerConfigJustRevealed(hasSignatureFields);
  }
  useEffect(() => {
    if (!signerConfigJustRevealed) return;
    const id = window.setTimeout(() => setSignerConfigJustRevealed(false), 6000);
    return () => window.clearTimeout(id);
  }, [signerConfigJustRevealed]);

  // Real measured heights of the 3 sticky columns' own content (form/PDF/
  // history) -- see `useHeightObserver`'s comment. `columnRailHeight` (the
  // max of the 3, only counting history when it's actually shown) is
  // passed to each `StickyAnchorColumn` below as `railHeight`, so each has
  // exactly enough room for its sticky content to fully release only once
  // the tallest column's content actually ends -- not a moment earlier.
  const [formContentHeight, setFormContentHeight] = useState(0);
  const [pdfContentHeight, setPdfContentHeight] = useState(0);
  const [historyContentHeight, setHistoryContentHeight] = useState(0);
  const formHeightObserver = useSyncedHeightObserver(setFormContentHeight);
  const pdfHeightObserver = useSyncedHeightObserver(setPdfContentHeight);
  const historyHeightObserver = useSyncedHeightObserver(setHistoryContentHeight);
  const registerFormContentRef = formHeightObserver.contentRef;
  const registerPdfContentRef = pdfHeightObserver.contentRef;
  const registerHistoryContentRef = historyHeightObserver.contentRef;

  // These 3 columns' heights specifically need the synchronous
  // `measureNow` correction (see `useSyncedHeightObserver`'s comment) -- a
  // dependency-less effect, so it runs after EVERY commit, since the
  // trigger isn't just `signerConfig`: `existingSignatures` resolving,
  // `showSignatureHistoryColumn` toggling, or an i18n language switch can
  // all change one of these 3 columns' real content height too.
  useLayoutEffect(() => {
    formHeightObserver.measureNow();
    pdfHeightObserver.measureNow();
    historyHeightObserver.measureNow();
  });


  // Real measured height of the sticky header block (site header + PDF
  // toolbar row) -- the 3 columns below anchor to `top: stickyOffset`, not
  // `top: 0`, so they don't end up stuck underneath it.
  const [stickyOffset, setStickyOffset] = useState(0);
  const registerStickyHeaderRef = useHeightObserver(setStickyOffset);

  // Each step starts at the top of the page. Without this the browser keeps
  // the scroll position from the previous step -- e.g. scrolled down past
  // the PDF preview to reach "Ký" in step 1 -- which on the shorter scan
  // step lands right on the video guide below the QR card.
  const previousStepRef = useRef(step);
  useEffect(() => {
    if (previousStepRef.current === step) return;
    previousStepRef.current = step;
    window.scrollTo({ top: 0 });
  }, [step]);

  // Mirrors Tailwind's default `lg` breakpoint (min-width: 1024px) and the
  // live viewport height in JS -- both needed because whether a column gets
  // `position: sticky` at all is now a per-column, runtime decision made
  // inside `StickyAnchorColumn`, which can't be expressed as a static
  // Tailwind class the way a plain breakpoint-gated style could.
  const [isLgUp, setIsLgUp] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(min-width: 1024px)').matches
  );
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === 'undefined' ? 0 : window.innerHeight
  );
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)');
    const handleChange = (event: MediaQueryListEvent) => setIsLgUp(event.matches);
    mql.addEventListener('change', handleChange);
    const handleResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener('resize', handleResize);
    return () => {
      mql.removeEventListener('change', handleChange);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  // `SignaturePlacement`'s page/zoom controls now render up here (in the
  // toolbar row below the header) instead of inside that component, so its
  // display state is mirrored up via these callbacks and its actions
  // (zoom/add-field/go-to-page) are invoked through an imperative ref --
  // see SignaturePlacement.tsx's own comment for why a plain controlled-prop
  // API doesn't fit (scrollToPage/addFieldToPage depend on internal refs).
  const signaturePlacementRef = useRef<SignaturePlacementHandle>(null);
  const [placementVisiblePage, setPlacementVisiblePage] = useState(1);
  const [placementPageCount, setPlacementPageCount] = useState<number | null>(null);
  const [placementZoomFactor, setPlacementZoomFactor] = useState(1);
  const [placementCanAddField, setPlacementCanAddField] = useState(false);

  const [signRequestId, setSignRequestId] = useState<string | null>(null);
  const [qrContent, setQrContent] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [orgIdSigned, setOrgIdSigned] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  // Signed PDF is fetched from CAS via identityKey EXACTLY ONCE (it has a
  // hard ~5-use budget) and kept only as an in-memory blob URL — both the
  // inline preview and the download button reuse this same blob, never
  // re-hitting /api/sign/download.
  const [signedPdfUrl, setSignedPdfUrl] = useState<string | null>(null);
  const [fetchingSignedPdf, setFetchingSignedPdf] = useState(false);
  const [signedPdfError, setSignedPdfError] = useState<string | null>(null);
  const [showDownloadReminder, setShowDownloadReminder] = useState(false);
  const signedPdfUrlRef = useRef<string | null>(null);

  // "Xem xác minh" popup state -- was `window.open('/verify/${orgIdSigned}')`
  // (a now-removed route); shows the same lookup in place instead.
  type VerifyPopupState =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'result'; data: SigningRoundDetail };
  const [verifyPopup, setVerifyPopup] = useState<VerifyPopupState | null>(null);
  const handleViewVerification = useCallback(async () => {
    if (!orgIdSigned) return;
    setVerifyPopup({ kind: 'loading' });
    const result = await lookupSigningRound(orgIdSigned);
    setVerifyPopup(
      result.ok
        ? { kind: 'result', data: result.data }
        : { kind: 'error', message: result.message || t('signingRound.notFound') }
    );
  }, [orgIdSigned, t]);

  // Auto-detect signature(s) already in the uploaded file — silent, courtesy
  // check only; it never gates the main placement/sign flow (matches
  // x-sign-web's behavior exactly). See the effect below.
  const [existingSignatures, setExistingSignatures] = useState<VerificationResult[]>([]);
  const [signatureSidebarOpen, setSignatureSidebarOpen] = useState(false);
  /** True while the silent existing-signature check below is in flight, so
   * the toolbar can show a "verifying" spinner instead of nothing. */
  const [checkingSignatures, setCheckingSignatures] = useState(false);

  const currentStepIndex = STEP_ORDER.indexOf(step);
  const steps = useMemo(
    () => [
      { key: 'upload', label: t('steps.uploadRequest') },
      { key: 'scan', label: t('steps.scan') },
      { key: 'done', label: t('steps.done') },
    ],
    [t]
  );
  const progressLabel = t('steps.progressLabel', {
    current: currentStepIndex + 1,
    total: steps.length,
  });

  // Resume an IN-PROGRESS session from localStorage on mount. A terminal
  // session is never resumed this way any more — it gets cleared the moment
  // it becomes terminal (see the polling effect below), so there is nothing
  // left to resume; reloading after that just starts fresh — EXCEPT a
  // still-unexpired identityKey from a just-finished SIGNED round, which is
  // kept specifically so "Tiếp tục ký"/"Tải lại" work even after a reload.
  useEffect(() => {
    const savedId = window.localStorage.getItem(LS_KEYS.signRequestId);
    const savedStatus = window.localStorage.getItem(LS_KEYS.status);
    // Deliberate one-time resume from localStorage (browser-only) after mount
    // — a lazy useState initializer would run during SSR too and mismatch on
    // hydration, so a mount effect is the correct pattern here.
    if (savedId && savedStatus && !TERMINAL_STATUSES.has(savedStatus)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSignRequestId(savedId);
      setStep('scan');
      return;
    }

    // A file handed in from the home page always starts a fresh round at
    // the upload step -- never jump to a previous round's "done" step.
    if (initialFile) return;

    const savedIdentityKey = window.localStorage.getItem(LS_KEYS.identityKey);
    const savedExpiresAt = window.localStorage.getItem(LS_KEYS.identityKeyExpiresAt);
    // Deliberately does NOT auto-fetch the signed PDF here — that would spend
    // one of identityKey's ~5 CAS uses on every single reload. Only the
    // buttons show; a fetch happens only once the user actually clicks one.
    if (savedIdentityKey && savedExpiresAt && new Date(savedExpiresAt).getTime() > Date.now()) {
      setStatus('SIGNED');
      setStep('done');
    }
  }, [initialFile]);

  // Revoke the blob URL when it changes or the component unmounts.
  useEffect(() => {
    signedPdfUrlRef.current = signedPdfUrl;
  }, [signedPdfUrl]);
  useEffect(() => {
    return () => {
      if (signedPdfUrlRef.current) URL.revokeObjectURL(signedPdfUrlRef.current);
    };
  }, []);

  // Silently check the uploaded file for signature(s) it already carries, so
  // the sidebar can surface them without ever blocking or delaying the
  // placement/sign flow. Only relevant on the upload/placement step — reset
  // as soon as the file changes or the wizard moves past it.
  useEffect(() => {
    if (!file || step !== 'upload') {
      // Reset is intentionally synchronous: this effect exists specifically
      // to keep existingSignatures/signatureSidebarOpen in sync with
      // file/step, so there is no "external system" to defer to here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExistingSignatures([]);
      setSignatureSidebarOpen(false);
      setCheckingSignatures(false);
      return;
    }

    let cancelled = false;
    (async () => {
      setCheckingSignatures(true);
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/verify/upload', { method: 'POST', body: form });
        if (cancelled) return;
        if (!res.ok) {
          // Still silent on screen, but visible in DevTools for debugging.
          console.warn('[verify] verification request failed', res.status, await parseJsonSafely(res).catch(() => null));
          return;
        }
        const data = await parseJsonSafely(res);
        if (cancelled) return;
        const signatures: VerificationResult[] = Array.isArray(data.signatures)
          ? data.signatures
          : [];
        logSignatureProblems(signatures);
        // Auto-opens by default the moment existing signatures are found
        // (product decision: surface them immediately, not just via the
        // toggle button). The earlier "opens then immediately closes"
        // reports were actually 2 separate real bugs, not caused by this
        // auto-open itself: (1) `VerificationResultCard`'s whole card being
        // one big click target, so clicking inside an expanded chain detail
        // re-toggled it closed, and (2) `StickyAnchorColumn` rendering 2
        // structurally different DOM shapes depending on measured height,
        // which could remount this whole column (and, worse, the sibling
        // PDF column) when a signature's detail expanded and changed this
        // column's height. Both are fixed at the source now.
        setExistingSignatures(signatures);
        if (signatures.length > 0) setSignatureSidebarOpen(true);
      } catch (error) {
        // Silent on screen by design — a courtesy detection, never surfaced
        // as an error — but logged for debugging.
        console.warn('[verify] verification request failed', error);
      } finally {
        if (!cancelled) setCheckingSignatures(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file, step]);

  const handleFileSelected = (selected: File | null) => {
    if (!selected) return;
    const isPdfMime = selected.type === 'application/pdf';
    const isPdfExtension = selected.name.toLowerCase().endsWith('.pdf');
    if (!isPdfMime && !isPdfExtension) {
      setUploadError(t('upload.errorNotPdf'));
      return;
    }
    if (selected.size > MAX_SIGN_UPLOAD_SIZE_MB * 1024 * 1024) {
      setUploadError(t('upload.errorTooLarge', { maxMb: MAX_SIGN_UPLOAD_SIZE_MB }));
      return;
    }
    setUploadError(null);
    setFile(selected);
    setSignatureFields([]);
    setSignerConfigJustRevealed(false);
  };

  const showSignatureHistoryColumn = signatureSidebarOpen && existingSignatures.length > 0;  // The whole left column (dropzone + file info + signer config) is only
  // shown while at least one signature field exists, so a user with no
  // field yet sees just the PDF and the "Chọn vị trí ký" action. Always
  // shown without a file (e.g. resumed session after reload, then "Quay lại
  // chỉnh sửa") -- otherwise there'd be no way to upload one.
  const showSignerColumn = !file || hasSignatureFields;
  const fieldsOnVisiblePage = signatureFields.filter(
    (field) => field.page === placementVisiblePage
  ).length;
  const columnRailHeight =
    Math.max(
      showSignerColumn ? formContentHeight : 0,
      pdfContentHeight,
      showSignatureHistoryColumn ? historyContentHeight : 0
    ) || undefined;
  // Shared with the toolbar row's own grid below, so its content lines up
  // exactly with the PDF (center) column's left/right edges instead of
  // spanning the whole page width -- see that row's own comment.
  // Left/right sidebar columns at 80% of their original share, with the
  // freed-up width added to the PDF (center) column, so the PDF renders
  // noticeably larger without changing the overall page width.
  // Without the left column, its track is dropped entirely so the PDF takes
  // that width too (pdf.js re-renders at the new width via
  // SignaturePlacement's ResizeObserver).
  const showToolbarControls = step === 'upload' && Boolean(file);

  // "Lịch sử ký" is centered over the signature-history card while that
  // column is open. The toolbar and the card sit in differently padded
  // containers, so this can't be pure CSS: measure the column's horizontal
  // center relative to the toolbar row, re-measured whenever either resizes
  // (the column narrows/widens as the signer column opens/closes).
  const toolbarRowRef = useRef<HTMLDivElement | null>(null);
  const historyColumnElRef = useRef<HTMLDivElement | null>(null);
  const registerHistoryColumn = useCallback(
    (el: HTMLDivElement | null) => {
      registerHistoryContentRef(el);
      historyColumnElRef.current = el;
    },
    [registerHistoryContentRef]
  );
  const [historyToggleCenterX, setHistoryToggleCenterX] = useState<number | null>(null);
  useEffect(() => {
    const column = historyColumnElRef.current;
    const row = toolbarRowRef.current;
    if (!showSignatureHistoryColumn || !isLgUp || !column || !row) return;
    const update = () => {
      const c = column.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      setHistoryToggleCenterX(Math.round(c.left + c.width / 2 - r.left));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(column);
    observer.observe(row);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [showSignatureHistoryColumn, isLgUp]);
  const historyToggleCentered =
    showSignatureHistoryColumn && isLgUp && historyToggleCenterX != null;

  const gridColsClassName = showSignerColumn
    ? showSignatureHistoryColumn
      ? 'lg:grid-cols-[minmax(260px,0.48fr)_minmax(0,1.62fr)_minmax(320px,0.5fr)]'
      : 'lg:grid-cols-[minmax(0,1.86fr)_minmax(340px,0.54fr)]'
    : showSignatureHistoryColumn
      ? 'lg:grid-cols-[minmax(260px,0.48fr)_minmax(0,1.86fr)]'
      : 'lg:grid-cols-1';

  const canSubmit =
    Boolean(file) &&
    signatureFields.length > 0 &&
    isCasSignerConfigValid(signerConfig) &&
    !submitting;

  const handleSubmit = useCallback(async () => {
    if (!file) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('signatureFields', JSON.stringify(signatureFields));
      form.append('signerType', signerConfig.signerKind);
      const identification = signerConfig.identificationNumber.trim();
      if (identification) form.append('identificationNumber', identification);
      if (signerConfig.signerKind === 'enterprise') {
        form.append('taxCode', signerConfig.taxCode.trim());
        form.append('organizationName', signerConfig.organizationName.trim());
        form.append('representativeName', signerConfig.representativeName.trim());
      }
      form.append('language', i18n.language?.startsWith('en') ? 'en' : 'vi');

      const res = await fetch('/api/sign/request', { method: 'POST', body: form });
      const data = await parseJsonSafely(res);
      if (!res.ok) {
        // `detail` (CAS errorCode/status, or a timeout flag) only ever
        // reached the server's own terminal log before -- logging the full
        // body here means opening DevTools on a real deploy shows the same
        // thing, not just the generic message shown on screen below.
        console.warn('[sign:request] failed', data);
        throw new Error(data.message ?? 'Gửi yêu cầu ký thất bại');
      }

      window.localStorage.setItem(LS_KEYS.signRequestId, data.signRequestId);
      window.localStorage.setItem(LS_KEYS.status, 'NEW');
      window.localStorage.setItem(LS_KEYS.documentName, file.name);
      window.localStorage.setItem(LS_KEYS.createdAt, new Date().toISOString());

      setSignRequestId(data.signRequestId);
      setQrContent(data.qrContent);
      setStatus('PENDING');
      setStep('scan');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [file, signatureFields, signerConfig, i18n.language]);

  /** Shared fetch+error-handling for /api/sign/download — used both to show
   * the inline preview (fetchSignedPdfOnce, below) and to feed a fresh File
   * back into the wizard for "Tiếp tục ký" (handleContinueSigning). Callers
   * share the same ~5-use CAS budget, so this is the only place in this
   * component that ever calls the route -- the actual HTTP call itself now
   * lives in `lib/downloadSignedPdf.ts` (shared with the home page's
   * "recent signatures" download button), this wrapper just keeps the
   * React loading/error state around it exactly as before. */
  const downloadSignedPdfBlob = useCallback(async (identityKey: string): Promise<Blob | null> => {
    setFetchingSignedPdf(true);
    setSignedPdfError(null);
    try {
      return await fetchSignedPdfBytes(identityKey);
    } catch (err) {
      // Already console.warn'd with the full response body inside
      // `downloadSignedPdfBlob` (lib/downloadSignedPdf.ts) -- this just
      // surfaces the (already-friendly) message to the UI.
      setSignedPdfError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setFetchingSignedPdf(false);
    }
  }, []);

  /** Fetch the signed PDF from CAS exactly once (identityKey's ~5-use budget)
   * and keep it as an in-memory blob for both preview + download. */
  const fetchSignedPdfOnce = useCallback(
    async (identityKey: string): Promise<string | null> => {
      const blob = await downloadSignedPdfBlob(identityKey);
      if (!blob) return null;
      const url = URL.createObjectURL(blob);
      setSignedPdfUrl(url);
      setShowDownloadReminder(true);
      return url;
    },
    [downloadSignedPdfBlob]
  );

  // Poll status every 4s while on the scan step.
  useEffect(() => {
    if (step !== 'scan' || !signRequestId) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/sign/status?signRequestId=${encodeURIComponent(signRequestId)}`
        );
        const data = await parseJsonSafely(res);
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 429) {
            timeoutId = setTimeout(poll, 8000);
            return;
          }
          console.warn('[sign:status] poll failed', data);
          setStatusError(data.message ?? 'status error');
          timeoutId = setTimeout(poll, 6000);
          return;
        }
        setStatusError(null);
        setStatus(data.status);
        if (data.expiresIn)
          setExpiresAt(new Date(Date.now() + data.expiresIn * 1000).toISOString());

        if (TERMINAL_STATUSES.has(data.status)) {
          if (data.status === 'SIGNED' && data.identityKey) {
            // Keep identityKey (+ its CAS expiry, + documentName) a little
            // longer on purpose — everything else about this round is done
            // and clears immediately as before (explicit product
            // requirement), but this lets "Tiếp tục ký"/"Tải lại" keep
            // working even after a reload (see the mount effect above).
            clearRoundKeepPendingIdentity();
            window.localStorage.setItem(LS_KEYS.identityKey, data.identityKey);
            if (data.identityKeyExpiresAt) {
              window.localStorage.setItem(LS_KEYS.identityKeyExpiresAt, data.identityKeyExpiresAt);
            }
            if (data.orgIdSigned) {
              setOrgIdSigned(data.orgIdSigned);
              // Feeds the home page's "5 phiên ký gần nhất" list -- same
              // documentName fallback convention as handleContinueSigning.
              addRecentSignature({
                code: data.orgIdSigned,
                name: window.localStorage.getItem(LS_KEYS.documentName) || 'signed.pdf',
                signedAt: new Date().toISOString(),
                identityKey: data.identityKey,
                identityKeyExpiresAt: data.identityKeyExpiresAt,
              });
            }
          } else {
            // Nothing left to resume once terminal — clear right away so a
            // fresh signing session can start immediately (explicit product
            // requirement), independent of whether the user ever reloads.
            clearPersistedSession();
          }
          setStep('done');
          if (data.status === 'SIGNED' && data.identityKey)
            void fetchSignedPdfOnce(data.identityKey);
          return;
        }
        window.localStorage.setItem(LS_KEYS.status, data.status);
        timeoutId = setTimeout(poll, 4000);
      } catch (err) {
        if (!cancelled) {
          console.warn('[sign:status] poll request failed', err);
          setStatusError(err instanceof Error ? err.message : String(err));
          timeoutId = setTimeout(poll, 6000);
        }
      }
    };

    poll();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [step, signRequestId, fetchSignedPdfOnce]);

  const handleSyncStatus = useCallback(async () => {
    if (!signRequestId) return;
    try {
      const res = await fetch(
        `/api/sign/status?signRequestId=${encodeURIComponent(signRequestId)}`
      );
      const data = await parseJsonSafely(res);
      if (!res.ok) {
        // Previously silent on failure -- a manual "Cập nhật trạng thái"
        // click that does nothing and shows nothing is the worst version of
        // this bug (the user asked for a status update and got no feedback
        // at all, not even an error).
        console.warn('[sign:status] manual sync failed', data);
        setStatusError(data.message ?? 'status error');
        return;
      }
      setStatusError(null);
      setStatus(data.status);
    } catch (err) {
      console.warn('[sign:status] manual sync request failed', err);
      setStatusError(err instanceof Error ? err.message : String(err));
    }
  }, [signRequestId]);

  /** "Quay lại" on the Quét QR step -- for when the signer notices they
   * picked the wrong signature position or entered the wrong signer info
   * AFTER already submitting to CAS. CAS has no cancel/withdraw API (once
   * `submitDocument` succeeds, the request just sits there until scanned,
   * rejected, or it expires on its own) -- so this can only stop tracking
   * it locally and go back to step 1, not truly cancel it on CAS's side.
   * Deliberately keeps `file`/`signatureFields`/`signerConfig` (unlike
   * `resetFlow`, which clears everything) so the user can fix the mistake
   * without re-uploading. Must still clear localStorage (not just state) --
   * otherwise a reload right after going back would hit the mount-only
   * resume effect above and jump straight back into 'scan' with the very
   * request the user just walked away from. */
  const handleBackToPlacement = useCallback(() => {
    clearPersistedSession();
    setSignRequestId(null);
    setQrContent(null);
    setExpiresAt(null);
    setStatus(null);
    setStatusError(null);
    setOrgIdSigned(null);
    setSubmitError(null);
    setStep('upload');
  }, []);

  const [qrLinkCopied, setQrLinkCopied] = useState(false);
  const handleCopyQrLink = useCallback(() => {
    if (!qrContent) return;
    navigator.clipboard
      .writeText(qrContent)
      .then(() => {
        setQrLinkCopied(true);
        window.setTimeout(() => setQrLinkCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard may be unavailable (permissions/non-secure context) --
        // the raw link is still visible right next to this button either
        // way, so failing silently here doesn't strand the user.
      });
  }, [qrContent]);

  const resetFlow = () => {
    clearPersistedSession();
    if (signedPdfUrlRef.current) URL.revokeObjectURL(signedPdfUrlRef.current);
    if (onBackToHome) {
      onBackToHome();
      return;
    }
    setStep('upload');
    setFile(null);
    setSignatureFields([]);
    setSignerConfigJustRevealed(false);
    setSignerConfig(DEFAULT_SIGNER_CONFIG);
    setSignRequestId(null);
    setQrContent(null);
    setExpiresAt(null);
    setStatus(null);
    setStatusError(null);
    setOrgIdSigned(null);
    setSubmitError(null);
    setSignedPdfUrl(null);
    setSignedPdfError(null);
    setShowDownloadReminder(false);
  };

  const triggerDownload = useCallback(
    (urlOverride?: string) => {
      const url = urlOverride ?? signedPdfUrl;
      if (!url) return;
      const a = document.createElement('a');
      a.href = url;
      a.download = signedFileName(window.localStorage.getItem(LS_KEYS.documentName));
      a.click();
    },
    [signedPdfUrl]
  );

  /** Download button on the Done step: reuse the already-fetched blob if we
   * have one (the common case, right after finishing), otherwise fetch it
   * first — covers resuming to the Done step after a reload, where nothing
   * has been fetched yet (see the mount effect). */
  const handleDownloadClick = useCallback(async () => {
    if (signedPdfUrl) {
      triggerDownload();
      return;
    }
    const savedIdentityKey = window.localStorage.getItem(LS_KEYS.identityKey);
    if (!savedIdentityKey) return;
    const url = await fetchSignedPdfOnce(savedIdentityKey);
    if (url) triggerDownload(url);
  }, [signedPdfUrl, triggerDownload, fetchSignedPdfOnce]);

  /** "Tiếp tục ký" — chain a new signing round onto the just-signed PDF.
   * Re-downloads the signed bytes via the persisted identityKey (spending
   * one more of its ~5 uses — the trade-off of not holding the file in
   * IndexedDB), wraps them into a fresh File, and hands the wizard back to
   * the placement step exactly like a fresh upload would (see
   * HomeLanding's initialFile hand-off — same mechanism). Deliberately keeps
   * signerConfig (a re-signer is usually the same person/entity). */
  const handleContinueSigning = useCallback(async () => {
    const savedIdentityKey = window.localStorage.getItem(LS_KEYS.identityKey);
    if (!savedIdentityKey) return;
    const savedName = window.localStorage.getItem(LS_KEYS.documentName) || 'signed.pdf';

    const blob = await downloadSignedPdfBlob(savedIdentityKey);
    if (!blob) return; // error already surfaced via signedPdfError

    // This identityKey has now served its purpose — consume it.
    clearPersistedSession();
    if (signedPdfUrlRef.current) URL.revokeObjectURL(signedPdfUrlRef.current);

    const newFile = new File([blob], savedName, { type: 'application/pdf' });
    setSignedPdfUrl(null);
    setShowDownloadReminder(false);
    setSignRequestId(null);
    setQrContent(null);
    setExpiresAt(null);
    setStatus(null);
    setStatusError(null);
    setOrgIdSigned(null);
    setSubmitError(null);
    setSignedPdfError(null);
    setSignatureFields([]);
    setSignerConfigJustRevealed(false);
    setFile(newFile);
    setStep('upload');
  }, [downloadSignedPdfBlob]);

  const handleCopyCode = async () => {
    if (!orgIdSigned) return;
    try {
      await navigator.clipboard.writeText(orgIdSigned);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; fail silently.
    }
  };

  const isPending = status === 'PENDING' || status === 'ACCEPTED' || status === null;
  const isTerminal = status ? TERMINAL_STATUSES.has(status) : false;

  return (
    <div className="flex min-h-screen flex-col bg-[#F5FBF7] text-text-main">
      {/* Header + PDF toolbar, stuck together at the top of the page
          (`sticky top-0`) since the page itself now has a single, ordinary
          scroll (see `main` below) instead of being viewport-locked with its
          own internal scroll container. The step indicator used to live
          here too; it's now a `fixed` footer instead (see the bottom of
          this component's JSX, right after `</main>`), pinned to the
          viewport bottom the same way this block is pinned to the top. Its
          own measured height (`registerStickyHeaderRef` -> `stickyOffset`)
          is what the 3 columns further down anchor their own `top: sticky`
          offset to, so they don't end up stuck underneath it. */}
      <div ref={registerStickyHeaderRef} className="sticky top-0 z-30">
        <Header maxWidthClassName="max-w-6xl" onLogoClick={resetFlow} />

        {/* Toolbar row, 3 zones:
            - left: "Lịch sử ký" -- centered over the signature-history card
              while that column is open (measured, see historyToggleCenterX),
              otherwise at the row's left edge;
            - center: the 3-step indicator (moved up here from a fixed bottom
              footer), exactly centered on the page via the equal `1fr`
              side tracks, `lg`+ only (no room below that);
            - right: page nav, zoom, "Chọn vị trí ký", field counter.
            Rendered on every step so the step indicator stays visible; the
            side zones only exist while placing fields (upload step with a
            file). Kept below the header rather than merged into it (tried
            and reverted: too cramped). `overflow-x-clip` keeps the
            "Chọn vị trí ký" ping ring from widening the page. */}
        <div
          className={`overflow-x-clip border-b border-border-subtle bg-white/95 backdrop-blur ${
            showToolbarControls ? '' : 'hidden lg:block'
          }`}
        >
          <div
            ref={toolbarRowRef}
            className="relative flex w-full flex-wrap items-center gap-2 px-4 py-2 sm:px-6 lg:grid lg:grid-cols-[1fr_auto_1fr]"
          >
            <div className="flex min-h-9 items-center">
              {showToolbarControls && checkingSignatures && (
                <span
                  role="status"
                  className="inline-flex items-center gap-2 whitespace-nowrap rounded-full border border-border-subtle bg-white px-3 py-1.5 text-xs font-semibold text-text-secondary shadow-sm"
                >
                  <InlineSpinner />
                  {t('sign.checkingSignatures')}
                </span>
              )}
              {showToolbarControls && !checkingSignatures && existingSignatures.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSignatureSidebarOpen((open) => !open)}
                  aria-expanded={signatureSidebarOpen}
                  style={historyToggleCentered ? { left: historyToggleCenterX ?? undefined } : undefined}
                  className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border-subtle bg-white px-3 py-1.5 text-xs font-semibold text-primary-strong shadow-sm transition-colors hover:border-primary hover:text-primary ${
                    historyToggleCentered ? 'absolute top-1/2 -translate-x-1/2 -translate-y-1/2' : ''
                  }`}
                >
                  <Icon
                    icon={signatureSidebarOpen ? 'lucide:x' : 'lucide:history'}
                    className="h-4 w-4"
                  />
                  {t('signatureHistory.title')}
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary-strong">
                    {existingSignatures.length}
                  </span>
                </button>
              )}
            </div>
            <div className="hidden lg:flex lg:justify-center">
              <HeaderSteps steps={steps} currentStepIndex={currentStepIndex} />
            </div>
            {showToolbarControls && (
              <div className="ml-auto flex flex-wrap items-center justify-end gap-2 lg:ml-0 lg:justify-self-end">
                {/* Neutral/white -- deliberately NOT the green `bg-primary`
                    treatment, so only "Chọn vị trí ký" and "Ký" (the actual
                    primary actions) read as green/highlighted; page-nav/zoom
                    stay small/secondary. */}
                <div className="flex items-center gap-1.5 rounded-full border border-border-subtle bg-white px-2 py-1 text-xs text-text-secondary shadow-sm">
                  <input
                    type="number"
                    step={1}
                    min={1}
                    max={placementPageCount ?? undefined}
                    value={placementVisiblePage}
                    onChange={(e) => {
                      const value = e.currentTarget.valueAsNumber;
                      if (Number.isFinite(value)) signaturePlacementRef.current?.goToPage(value);
                    }}
                    aria-label={t('common.page')}
                    className="w-8 rounded-full bg-surface-soft px-1 text-center text-xs text-text-main outline-none [appearance:textfield] focus:ring-2 focus:ring-primary/40 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  {placementPageCount ? <span>{`/ ${placementPageCount}`}</span> : null}
                  <span className="mx-0.5 h-3.5 w-px bg-border-subtle" aria-hidden="true" />
                  <button
                    type="button"
                    onClick={() => signaturePlacementRef.current?.zoomOut()}
                    disabled={placementZoomFactor <= ZOOM_MIN}
                    aria-label={t('sign.zoomOut')}
                    title={t('sign.zoomOut')}
                    className="rounded-full px-1.5 font-semibold hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    −
                  </button>
                  <span className="w-9 text-center tabular-nums">
                    {Math.round(placementZoomFactor * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => signaturePlacementRef.current?.zoomIn()}
                    disabled={placementZoomFactor >= ZOOM_MAX}
                    aria-label={t('sign.zoomIn')}
                    title={t('sign.zoomIn')}
                    className="rounded-full px-1.5 font-semibold hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
                {/* `animate-ping` on a sibling ring, not `animate-pulse` on the
                    button itself -- pulsing opacity would read like this
                    button's own `disabled:opacity-60` state. */}
                <span className="relative isolate inline-flex">
                  {placementCanAddField && signatureFields.length === 0 && (
                    <span
                      aria-hidden="true"
                      className="absolute inset-0 -z-10 animate-ping rounded-full bg-primary/40"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => signaturePlacementRef.current?.addField()}
                    disabled={!placementCanAddField}
                    className="inline-flex items-center justify-center whitespace-nowrap rounded-full bg-primary px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {t('sign.addField')}
                  </button>
                </span>
                {/* How many boxes exist in total and on the visible page, so
                    users can see at a glance if they added too many (there
                    is no per-page cap any more). */}
                {hasSignatureFields && (
                  <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border-subtle bg-white px-2.5 py-1 text-xs font-semibold text-text-secondary">
                    <Icon icon="lucide:pen-line" className="h-3.5 w-3.5" />
                    {t('sign.fieldCounter', {
                      total: signatureFields.length,
                      onPage: fieldsOnVisiblePage,
                    })}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <main className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex w-full flex-1 flex-col px-4 py-4 sm:px-6 sm:py-5"
        >
          {step === 'upload' && (
            <section className="mb-4 mt-2 flex flex-col">
              <SigningCard className="flex flex-1 flex-col">
                <SigningStepHeader
                  stepNumber={1}
                  title={t('upload.title')}
                  trailingContent={progressLabel}
                />
                <div className={`mt-4 grid gap-6 ${gridColsClassName}`}>
                  {showSignatureHistoryColumn && (
                    <StickyAnchorColumn
                      railHeight={columnRailHeight}
                      railClassName="max-lg:order-last"
                      contentHeight={historyContentHeight}
                      stickyOffset={stickyOffset}
                      viewportHeight={viewportHeight}
                      isLgUp={isLgUp}
                      className="flex flex-col"
                      contentRef={registerHistoryColumn}
                    >
                      <SignatureHistorySidebar
                        onClose={() => setSignatureSidebarOpen(false)}
                        signatures={existingSignatures}
                      />
                    </StickyAnchorColumn>
                  )}
                  {/* Same `StickyAnchorColumn` as the side columns --
                        see its own module comment for the 3-way decision
                        (plain/sticky/clipped+reveal), driven by this
                        column's measured height vs. `columnRailHeight`
                        (shared across all 3, so whichever ends up tallest
                        naturally gets the "plain, no sticky" treatment)
                        and the viewport. */}
                  <StickyAnchorColumn
                    railHeight={columnRailHeight}
                    contentHeight={pdfContentHeight}
                    stickyOffset={stickyOffset}
                    viewportHeight={viewportHeight}
                    isLgUp={isLgUp}
                    className="flex flex-col"
                    contentRef={registerPdfContentRef}
                  >
                    {file ? (
                      <SignaturePlacement
                        ref={signaturePlacementRef}
                        file={file}
                        fields={signatureFields}
                        onFieldsChange={setSignatureFields}
                        onVisiblePageChange={setPlacementVisiblePage}
                        onPageCountChange={setPlacementPageCount}
                        onZoomFactorChange={setPlacementZoomFactor}
                        onCanAddFieldChange={setPlacementCanAddField}
                      />
                    ) : (
                      <div className="mx-auto flex min-h-[360px] w-full flex-col items-center justify-center rounded-xl border border-border-subtle bg-surface-soft px-4 py-8 text-center">
                        <p className="text-sm font-medium text-text-main">
                          {t('upload.uploadPreview')}
                        </p>
                        <p className="mt-2 text-xs text-text-muted sm:text-sm">
                          {t('sign.needUploadForPreview')}
                        </p>
                      </div>
                    )}
                  </StickyAnchorColumn>

                  {/* Signer column (upload + signer details), RIGHT of the PDF.
                      Below `lg` it's moved first (order-first) so the form stays
                      above a long PDF on phones. */}
                  {/* Hidden, the column is unmounted and its grid track
                      dropped (see gridColsClassName), so the PDF widens into
                      that space; unmounting also disconnects its height
                      observer instead of keeping a stale height. */}
                  {!showSignerColumn ? null : (
                  <StickyAnchorColumn
                    railHeight={columnRailHeight}
                    railClassName="lg:pl-1 max-lg:order-first"
                    contentHeight={formContentHeight}
                    stickyOffset={stickyOffset}
                    viewportHeight={viewportHeight}
                    isLgUp={isLgUp}
                    className="flex flex-col gap-4"
                    contentRef={registerFormContentRef}
                  >
                    <>
                      {/* Always shown (reverted from an earlier "compact
                          one-line summary once a file is picked" version,
                          per explicit request this session) -- the big
                          drag-and-drop prompt stays visible, doubling as the
                          way to swap files, with a separate read-only card
                          below showing the currently-selected file once one
                          exists. */}
                      <label
                        htmlFor="file-input"
                        className={`flex w-full shrink-0 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition ${
                          dragCounter > 0
                            ? 'border-primary bg-surface-soft-strong ring-2 ring-primary/40'
                            : 'border-primary/50 bg-surface-soft hover:border-primary hover:bg-surface-soft-strong'
                        }`}
                        onDragEnter={(e) => {
                          e.preventDefault();
                          setDragCounter((prev) => prev + 1);
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'copy';
                        }}
                        onDragLeave={(e) => {
                          e.preventDefault();
                          setDragCounter((prev) => Math.max(0, prev - 1));
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDragCounter(0);
                          handleFileSelected(e.dataTransfer.files?.[0] ?? null);
                        }}
                      >
                        <span className="flex text-primary-strong">
                          <Icon icon="lucide:file-check-2" className="h-12 w-12" />
                        </span>
                        <p className="text-lg font-semibold text-text-main">{t('upload.title')}</p>
                        <p className="text-sm text-text-muted">{t('upload.dropHint')}</p>
                        <span className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white shadow-sm shadow-primary/40 transition-colors hover:bg-primary-strong">
                          {t('common.upload')}
                        </span>
                        <p className="text-[11px] text-text-soft">
                          {t('upload.requirements', { maxMb: MAX_SIGN_UPLOAD_SIZE_MB })}
                        </p>
                        {!file && (
                          <p className="mt-1 text-xs text-text-soft">{t('upload.noFile')}</p>
                        )}
                        <input
                          id="file-input"
                          type="file"
                          accept="application/pdf"
                          onChange={(e) => handleFileSelected(e.target.files?.[0] ?? null)}
                          className="sr-only"
                        />
                      </label>

                      {/* File info + signer config used to be 2 separate
                          bordered boxes stacked under the dropzone -- on top
                          of the dropzone's own border, that's 3 full outlines
                          in a row for one narrow column, which read as
                          visually noisy/cluttered. Merged into a single
                          bordered box, with a plain `border-t` divider line
                          between the two sections instead of each getting
                          its own full rounded border. */}
                      <div className="rounded-xl border border-border-subtle bg-surface-soft px-3 py-2.5 lg:min-h-0 lg:flex-1">
                        {file && (
                          <div className="flex w-full shrink-0 items-center gap-3 border-b border-border-subtle pb-2.5 mb-2.5">
                            <span className="flex shrink-0 text-primary-strong">
                              <Icon icon="lucide:file-check-2" className="h-8 w-8" />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-semibold text-text-main">
                                {file.name}
                              </div>
                              <div className="text-[11px] text-text-muted">
                                {formatFileSize(file.size)} · {t('upload.selectedLabel')}
                              </div>
                            </div>
                          </div>
                        )}
                        {/* Next-step cue after a field is placed: a pulsing
                            ring on its own overlay (pulsing the box itself
                            would fade the inputs too), for 6 s or until the
                            user starts filling it in. */}
                        <div
                          className="relative rounded-lg"
                          onFocusCapture={() => setSignerConfigJustRevealed(false)}
                        >
                          {signerConfigJustRevealed && (
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute -inset-2 animate-pulse rounded-xl ring-2 ring-primary"
                            />
                          )}
                          <SignerConfigPanel value={signerConfig} onChange={setSignerConfig} />
                        </div>
                      </div>

                      {/* "Ký" sits below the signer box, in the column's free
                          space (moved here from the bottom footer, which is
                          also hidden below `lg` -- phones had no "Ký" at all).
                          The ripple is box-shadow based (`animate-ky-ripple`,
                          app/globals.css) so it can't cause horizontal scroll. */}
                      <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                        className={`mt-[10px] inline-flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-full bg-primary px-6 py-2.5 text-base font-semibold text-white shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60 ${
                          canSubmit ? 'animate-ky-ripple' : ''
                        }`}
                      >
                        {submitting && <ButtonSpinner />}
                        {submitting ? t('common.submitting') : t('sign.submit')}
                      </button>

                      {uploadError && (
                        <div className="rounded-md border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text">
                          {uploadError}
                        </div>
                      )}
                    </>
                  </StickyAnchorColumn>
                  )}

                </div>
              </SigningCard>
            </section>
          )}

          {step === 'scan' && (
            // No `flex-1` here (unlike a previous version) -- letting the
            // card stretch to fill the remaining viewport height left a
            // large, visually awkward empty white block below this step's
            // short content (QR code + a couple lines). Same pattern as the
            // "upload" step's section just above: hug the content instead.
            // Card capped at a fine-tuned 1180px -- narrower than
            // `max-w-3xl` (visibly narrower than "Tải PDF"/"Tài liệu đã ký",
            // the mismatch this originally replaced) would allow, but well
            // short of fully unconstrained `w-full` (stretches past a sane
            // reading width on a very wide window, spreading the QR + text
            // grid so thin it looks broken/overflowing).
            <section className="mx-auto my-auto flex w-full max-w-[1180px] flex-col self-center">
              {/* The QR card owns the whole first screen (viewport minus the
                  measured sticky header and <main>'s vertical padding), so
                  the video guide below always starts past the fold and the
                  ScrollCue points down to it. */}
              <div
                className="flex flex-col justify-center"
                style={{ minHeight: `calc(100svh - ${stickyOffset}px - 2.5rem)` }}
              >
                <SigningCard className="flex flex-col">
                  <SigningStepHeader
                    stepNumber={2}
                    title={t('scan.title')}
                    trailingContent={progressLabel}
                  />
                  <p className="mt-1 text-sm text-text-muted">{t('scan.subtitle')}</p>
                  {statusError && (
                    <div className="mb-3 mt-3 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-text">
                      {t('scan.statusError')} <span className="font-mono">{statusError}</span>
                    </div>
                  )}
                  <div className="mx-auto mt-6 grid gap-8 lg:grid-cols-[minmax(280px,max-content)_minmax(0,420px)]">
                    <div className="flex flex-col items-start">
                      <div className="w-full max-w-xs rounded-xl border border-border-subtle bg-white p-4 shadow-sm">
                        <div className="flex justify-center">
                          <QRErrorBoundary
                            fallback={
                              <div className="max-w-xs text-sm text-red-600">
                                {t('scan.qrRenderFailed')} {t('scan.qrRenderFailedSeePayload')}
                              </div>
                            }
                          >
                            <QR
                              value={String(qrContent)}
                              size={240}
                              level="H"
                              logoSrc="/cas-id-logo.webp"
                            />
                          </QRErrorBoundary>
                        </div>
                      </div>
                      <p className="mt-3 text-sm text-text-muted">{t('scan.caption')}</p>
                      <div className="mt-1">
                        <ExpiresIn expiresAt={expiresAt} onExpired={() => setStatus('EXPIRED')} />
                      </div>
                    </div>
                    <div className="max-w-sm space-y-2 text-sm text-text-main">
                      <p>{t('scan.instruction')}</p>
                      <div className="pt-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                        {t('scan.qrPayload')}
                      </div>
                      {/* Compact single-line link + copy button, replacing the
                          old full-URL `<pre>` block -- the raw payload is
                          rarely something anyone reads character-by-character;
                          copying it (to paste into Cas ID, or share) is the
                          actual use case. */}
                      <div className="flex items-center gap-2">
                        <div
                          className="min-w-0 flex-1 truncate rounded-md bg-gray-50 px-3 py-2 text-xs text-text-main"
                          title={qrContent ?? undefined}
                        >
                          <span className="text-text-muted">{t('scan.linkLabel')} </span>
                          {qrContent}
                        </div>
                        <button
                          type="button"
                          onClick={handleCopyQrLink}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border-subtle bg-white px-3 py-1.5 text-xs font-medium text-text-secondary transition hover:border-primary hover:text-primary"
                        >
                          <Icon
                            icon={qrLinkCopied ? 'lucide:check' : 'lucide:copy'}
                            className="h-3.5 w-3.5"
                          />
                          {qrLinkCopied ? t('scan.copied') : t('scan.copyLink')}
                        </button>
                      </div>

                      <div className="flex items-center gap-2 pt-2">
                        <button
                          type="button"
                          onClick={handleSyncStatus}
                          className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-strong"
                        >
                          {t('scan.syncStatus')}
                        </button>
                        {/* Only while still waiting for a scan -- once the
                            signer has already approved (ACCEPTED), CAS is
                            already finishing the signing round, so going back
                            to fix the placement/signer info no longer means
                            anything (and there is no CAS-side cancel to
                            reflect it if we let them anyway). */}
                        {(status === null || status === 'PENDING') && (
                          <button
                            type="button"
                            onClick={handleBackToPlacement}
                            className="inline-flex items-center gap-1.5 rounded-full border border-primary bg-white px-3.5 py-1.5 text-sm font-semibold text-primary transition hover:bg-surface-soft"
                          >
                            {t('scan.back')}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Unconditional -- covers both paths ("scan" or "tap the
                      notification") as options, so it stays accurate whether
                      or not a CCCD was actually supplied in step 1 (the only
                      case CAS pushes a notification at all; see
                      SignerConfigPanel's own hint) -- unlike the narrower
                      `pushHint` this replaces, which specifically asserted a
                      push was sent and so had to stay conditional on that. */}
                  <div className="mt-6 flex items-start gap-2 rounded-xl border border-border-subtle bg-surface-soft px-4 py-3 text-sm text-primary-strong">
                    <Icon icon="lucide:info" className="mt-0.5 h-4 w-4 shrink-0" />
                    <p>
                      <span className="font-semibold">Tip:</span> {t('scan.tip')}
                    </p>
                  </div>

                  <div className="mt-6 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
                    <div className="font-medium text-text-main">{t('scan.status')}</div>
                    <div className="mt-1 space-y-1">
                      {isPending && (
                        <span className="inline-flex items-center gap-2 text-text-muted">
                          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                          {status === 'ACCEPTED' ? t('scan.accepted') : t('scan.waiting')}
                        </span>
                      )}
                    </div>
                    {isTerminal && (
                      <div className="mt-3 text-xs text-text-muted">
                        <button
                          type="button"
                          className="rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                          onClick={resetFlow}
                        >
                          {t('common.startOver')}
                        </button>
                      </div>
                    )}
                  </div>
                </SigningCard>
              </div>

              <CasIdVideoGuide />
              <ScrollCue targetId={CAS_ID_VIDEO_GUIDE_ID} label={t('scrollCue.scan')} />
            </section>
          )}

          {step === 'done' && (
            <section className="mb-6">
              <SigningCard>
                {/* Custom 3-slot header row (title / centered buttons /
                      progress label) instead of SigningStepHeader's plain
                      2-slot title+trailing layout -- that component's own
                      `justify-between` only ever pins trailingContent to the
                      far right, it can't center it in the remaining space.
                      Mirrors the same left/center/right pattern already used
                      for the site Header's logo/steps/right-controls row.
                      The 4 action buttons (+ "Bước 3/3") share this row
                      instead of their own separate rows underneath -- see
                      the PDF-preview height right below, which grows into
                      the space reclaimed here. Plain <button> markup (not
                      SigningPrimaryButton/SigningSecondaryButton) because
                      those components' own `px-6 py-2 text-sm` defaults
                      would conflict with a smaller size passed via
                      `className` -- Tailwind doesn't guarantee the override
                      wins without a merge utility this project doesn't
                      use. */}
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <h2 className="flex shrink-0 items-center gap-2 text-base font-semibold text-primary-strong sm:text-lg">
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white">
                      3
                    </span>
                    <span>{t('done.title')}</span>
                  </h2>
                  <div className="flex flex-1 flex-wrap items-center justify-center gap-2">
                    {status === 'SIGNED' && (
                      <>
                        <button
                          type="button"
                          disabled={fetchingSignedPdf}
                          onClick={handleDownloadClick}
                          className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {fetchingSignedPdf && <ButtonSpinner />}
                          {fetchingSignedPdf ? t('common.fetching') : t('common.downloadSignedPdf')}
                        </button>
                        <button
                          type="button"
                          disabled={fetchingSignedPdf}
                          onClick={handleContinueSigning}
                          className="inline-flex items-center gap-1.5 rounded-full border border-primary bg-white px-3.5 py-1.5 text-xs font-semibold text-primary shadow-sm transition hover:bg-surface-soft-strong disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {fetchingSignedPdf && <ButtonSpinner />}
                          {t('done.continueSigning')}
                        </button>
                        {orgIdSigned && (
                          <button
                            type="button"
                            onClick={() => void handleViewVerification()}
                            className="inline-flex items-center gap-1.5 rounded-full border border-primary bg-white px-3.5 py-1.5 text-xs font-semibold text-primary shadow-sm transition hover:bg-surface-soft-strong"
                          >
                            {t('done.verifyButton')}
                          </button>
                        )}
                      </>
                    )}
                    {/* Moved up from its own row below the PDF preview,
                          so that preview can grow taller into the space
                          reclaimed here. */}
                    <button
                      type="button"
                      onClick={resetFlow}
                      className="inline-flex items-center gap-1.5 rounded-full border border-primary bg-white px-3.5 py-1.5 text-xs font-semibold text-primary shadow-sm transition hover:bg-surface-soft-strong"
                    >
                      {t('common.startOver')}
                    </button>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-xs text-text-muted">
                    {progressLabel}
                  </span>
                </div>
                {status === 'SIGNED' ? (
                  <div className="mt-3">
                    {orgIdSigned && (
                      <div className="mt-4 flex flex-col items-center gap-2 sm:flex-row sm:justify-center">
                        <div className="flex items-center gap-1.5 text-xs text-text-muted">
                          {t('done.verificationCodeLabel')}:{' '}
                          <code className="break-all font-mono text-text-main">{orgIdSigned}</code>
                          <button
                            type="button"
                            onClick={handleCopyCode}
                            title={t('done.copyCodeTitle')}
                            aria-label={t('done.copyCodeTitle')}
                            className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-primary-strong hover:bg-surface-soft"
                          >
                            <Icon
                              icon={copied ? 'lucide:check' : 'lucide:copy'}
                              className="h-3.5 w-3.5"
                            />
                          </button>
                          {copied && (
                            <span className="text-primary-strong">{t('done.copied')}</span>
                          )}
                        </div>
                      </div>
                    )}

                    {signedPdfError && (
                      <div className="mt-3 rounded-md border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text">
                        {signedPdfError}
                      </div>
                    )}

                    <div className="mt-5">
                      {fetchingSignedPdf ? (
                        <div className="flex flex-col items-center justify-center rounded-xl border border-gray-200 bg-gray-50 px-4 py-6 text-center text-sm text-text-muted">
                          <InlineSpinner />
                          <p className="mt-2">{t('done.loadingInlinePreview')}</p>
                        </div>
                      ) : (
                        signedPdfUrl && (
                          <div className="rounded-xl border border-gray-200 bg-gray-50 p-2 sm:p-3">
                            <iframe
                              src={signedPdfUrl}
                              title={t('done.signedPdfTitle')}
                              className="h-[65vh] w-full rounded-lg bg-white lg:h-[calc(100vh-18rem)]"
                            />
                          </div>
                        )
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-center text-lg text-red-700">
                    {status === 'REJECTED'
                      ? t('scan.rejected')
                      : status === 'FAILED'
                        ? t('scan.failed')
                        : status === 'EXPIRED'
                          ? t('scan.expired')
                          : status}
                  </p>
                )}
              </SigningCard>
            </section>
          )}
        </div>
      </main>

      {/* Same full-width footer as the landing page, on the scan and done
          steps. Not on "upload": that step is a PDF workspace whose sticky
          columns are sized to the viewport. The Casso brand band stays on
          the landing page only. */}
      {step !== 'upload' && (
        <div className="border-t border-border-subtle bg-white">
          <Footer />
        </div>
      )}

      {showDownloadReminder && (
        <DownloadReminderModal
          isDownloading={fetchingSignedPdf}
          onDownload={() => {
            triggerDownload();
            setShowDownloadReminder(false);
          }}
          onDismiss={() => setShowDownloadReminder(false)}
        />
      )}

      {submitError && (
        <SignRequestErrorModal
          message={submitError}
          onRetry={() => {
            setSubmitError(null);
            void handleSubmit();
          }}
          onDismiss={() => setSubmitError(null)}
        />
      )}

      {verifyPopup && (
        <VerificationPopup onClose={() => setVerifyPopup(null)}>
          {verifyPopup.kind === 'loading' && (
            <div className="flex flex-col items-center justify-center py-10 text-center text-sm text-text-muted">
              <InlineSpinner />
              <p className="mt-2">{t('verify.loadingResult')}</p>
            </div>
          )}
          {verifyPopup.kind === 'error' && (
            <div className="px-2 py-6 text-center text-sm text-error-text">
              {verifyPopup.message}
            </div>
          )}
          {verifyPopup.kind === 'result' && <SigningRoundResult data={verifyPopup.data} />}
        </VerificationPopup>
      )}
    </div>
  );
}
