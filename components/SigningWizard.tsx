'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, DragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import Header from '@/components/Header';
import { HeaderSteps } from '@/components/signing/HeaderSteps';
import { WorkspacePane } from '@/components/signing/WorkspacePane';
import { ReviewSignedPane } from '@/components/signing/ReviewSignedPane';
import { QrSignDialog } from '@/components/signing/QrSignDialog';
import { SigningStatusPane } from '@/components/signing/SigningStatusPane';
import { SignFailedModal } from '@/components/signing/SignFailedModal';
import { SigningCard } from '@/components/signing/SigningCard';
import { SigningStepHeader } from '@/components/signing/SigningStepHeader';
import { ButtonSpinner, InlineSpinner } from '@/components/signing/Spinners';
import { MAX_SIGN_UPLOAD_SIZE_MB, formatFileSize } from '@/components/signing/constants';
import SignaturePlacement, {
  ZOOM_MIN,
  ZOOM_MAX,
  fieldOrdinals,
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
import { SignatureField, type SignatureFieldProps } from '@/lib/domain/SignatureField';
import { parseJsonSafely } from '@/lib/http';
import {
  addRecentSignature,
  getRecentSignatures,
  forgetIdentityKey,
  pendingCode,
  removeRecentSignature,
  replaceRecentSignature,
  updateRecentSignature,
  type RecentSignature,
} from '@/lib/recentSignatures';
import { clearActiveSession, getActiveSession, setActiveSession } from '@/lib/activeSession';
import {
  downloadSignedPdfBlob as fetchSignedPdfBytes,
  signedFileName,
  triggerBlobDownload,
} from '@/lib/downloadSignedPdf';
import { getSignedPdf, saveSignedPdf } from '@/lib/signedPdfStore';
import { pruneStoredPdfs } from '@/lib/browserHistory';
import {
  SESSION_KEYS,
  getSessionItem,
  removeSessionItem,
  setSessionItem,
} from '@/lib/signingSessionStorage';
import { lookupSigningRound } from '@/lib/signingRoundLookup';
import type { SigningRoundDetail } from '@/lib/cas/CasProvider';
import type { VerificationResult } from '@/lib/verification/verifyPdfSignatures';

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
 *
 * `initialReview` (with `initialFile` = that round's signed PDF) opens a
 * home-page "phiên ký gần nhất" entry in review mode: same 3-pane layout,
 * but read-only -- the right pane shows the signing details plus "Tải tài
 * liệu về" / "Ký tiếp" instead of the signer form ("Ký tiếp" drops into
 * normal placement on that same signed file).
 */

type Step = 'upload' | 'scan' | 'done';

/** The 4 steps the home page shows (same i18n keys, so they always match):
 * upload -> place the signature -> scan the QR -> get the signed PDF. The
 * internal `Step` stays 3-valued; the 'upload' step is shown as step 1
 * until a file is loaded, then as step 2 (placement). */
const DISPLAY_STEP_KEYS = ['upload', 'place', 'sign', 'download'] as const;

/**
 * Placement step layout: 3 panes (signature history / PDF / signer info).
 * At `lg` and up they fill a fixed, viewport-sized row and each pane
 * scrolls on its own (`WorkspacePane`), so the wheel only moves the pane
 * under the pointer -- an explicit product decision that replaced the
 * earlier "one single page scroll" sticky-column layout. Below `lg` the
 * panes stack and the page keeps a single ordinary scroll.
 */

// This tab's round lives in sessionStorage (lib/signingSessionStorage.ts):
// survives F5, not a new tab. `activeSession` is managed separately.
const LS_KEYS = {
  signRequestId: SESSION_KEYS.signRequestId,
  status: SESSION_KEYS.status,
  identityKey: SESSION_KEYS.identityKey,
  identityKeyExpiresAt: SESSION_KEYS.identityKeyExpiresAt,
  orgIdSigned: SESSION_KEYS.orgIdSigned,
  documentName: SESSION_KEYS.documentName,
  createdAt: SESSION_KEYS.createdAt,
  qrContent: SESSION_KEYS.qrContent,
} as const;

const TERMINAL_STATUSES = new Set(['SIGNED', 'REJECTED', 'FAILED', 'EXPIRED']);
const NO_FIELDS: SignatureFieldProps[] = [];

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
  for (const key of Object.values(LS_KEYS)) removeSessionItem(key);
}

/** Boxes read back from browser storage: anything malformed is dropped
 * (same checks the server applies), never trusted as-is. */
function validStoredFields(fields: unknown): SignatureFieldProps[] {
  if (!Array.isArray(fields)) return [];
  return fields.filter((field): field is SignatureFieldProps => {
    try {
      SignatureField.create(field as SignatureFieldProps);
      return true;
    } catch {
      return false;
    }
  });
}

/** A round ended without a signature: it leaves the recent list (explicit
 * product decision), but stays on screen -- and across a reload -- as the
 * active failed session, its original file kept under the same code. */
function rememberFailedRound(signRequestId: string | null, status: string, name: string) {
  if (!signRequestId) return;
  const code = pendingCode(signRequestId);
  const signatureFields = getRecentSignatures().find((e) => e.code === code)?.signatureFields;
  removeRecentSignature(code);
  setActiveSession({ kind: 'failed', code, name, status, signatureFields });
  pruneStoredPdfs();
}

/** On reaching SIGNED specifically, everything about *this* round is done
 * except `identityKey`/`identityKeyExpiresAt`/`documentName` — kept a little
 * longer, on purpose, so "Tiếp tục ký" (continue signing) still works even
 * after a reload, up until identityKey's own ~1-day CAS expiry (or until a
 * new round actually consumes it — see handleContinueSigning). */
function clearRoundKeepPendingIdentity() {
  removeSessionItem(LS_KEYS.signRequestId);
  removeSessionItem(LS_KEYS.status);
  removeSessionItem(LS_KEYS.orgIdSigned);
  removeSessionItem(LS_KEYS.createdAt);
  removeSessionItem(LS_KEYS.qrContent);
}

/**
 * Measures one element's rendered height via ResizeObserver, reporting it
 * through `setHeight`. Used for the sticky-header height below.
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
 * every callback -- real GPU-rendered browsers can report a sub-pixel-
 * different height from one reflow to the next for the exact same content,
 * and re-rendering on that noise is pointless.
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

const DEFAULT_SIGNER_CONFIG: CasSignerConfigValue = {
  signerKind: 'individual',
  identificationNumber: '',
  taxCode: '',
  organizationName: '',
  representativeName: '',
};

export function SigningWizard({
  initialFile = null,
  initialReview = null,
  onBackToHome,
}: {
  initialFile?: File | null;
  initialReview?: RecentSignature | null;
  onBackToHome?: () => void;
}) {
  const { t, i18n } = useTranslation();

  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(initialFile);
  /** The "Quét QR" popup over the workspace while a round is pending --
   * closing it keeps the round (and polling) going; see QrSignDialog. */
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  /** "Yêu cầu ký đã bị từ chối" (/expired/failed) popup -- only when the
   * result arrives while the user is here, not when restoring after F5. */
  const [failedNoticeOpen, setFailedNoticeOpen] = useState(false);
  /** Set while viewing an already-signed recent round (see `initialReview`). */
  const [review, setReview] = useState<RecentSignature | null>(initialReview);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragCounter, setDragCounter] = useState(0);
  const [signerConfig, setSignerConfig] = useState<CasSignerConfigValue>(DEFAULT_SIGNER_CONFIG);
  const [signatureFields, setSignatureFields] = useState<SignatureFieldProps[]>([]);

  // The signer details (signer config + "Ký") in the right pane follow
  // whether the document currently has any signature field: they appear
  // with the first one and give way to a hint once the last one is removed.
  // Each time fields go from none to some, the signer-config box is
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

  // Real measured height of the sticky header block (site header + PDF
  // toolbar row) -- sizes the placement workspace (viewport minus this) on
  // wide screens, and offsets page jumps on phones.
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

  // Mirrors Tailwind's default `lg` breakpoint (min-width: 1024px) in JS:
  // only at lg+ does the PDF pane scroll on its own (so it's handed to
  // SignaturePlacement as `scrollRoot`), and the "Lịch sử ký" toggle is
  // centered over the history pane.
  const [isLgUp, setIsLgUp] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia('(min-width: 1024px)').matches
  );
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)');
    const handleChange = (event: MediaQueryListEvent) => setIsLgUp(event.matches);
    mql.addEventListener('change', handleChange);
    return () => mql.removeEventListener('change', handleChange);
  }, []);
  // The PDF pane's scrolling body (WorkspacePane's `bodyRef`), as state so
  // SignaturePlacement re-binds its scroll listeners once it exists.
  const [pdfScrollEl, setPdfScrollEl] = useState<HTMLDivElement | null>(null);

  // `SignaturePlacement`'s page/zoom controls now render up here (in the
  // toolbar row below the header) instead of inside that component, so its
  // display state is mirrored up via these callbacks and its actions
  // (zoom/add-field/go-to-page) are invoked through an imperative ref --
  // see SignaturePlacement.tsx's own comment for why a plain controlled-prop
  // API doesn't fit (scrollToPage/addFieldToPage depend on internal refs).
  const signaturePlacementRef = useRef<SignaturePlacementHandle>(null);

  // Phones: the signer pane sits below the PDF and the history, so once a
  // box is placed a floating pen button jumps down to it -- hidden while
  // that pane is already on screen (it would cover "Ký").
  const signerPaneRef = useRef<HTMLDivElement | null>(null);
  const [signerPaneVisible, setSignerPaneVisible] = useState(false);
  useEffect(() => {
    const pane = signerPaneRef.current;
    if (!pane || isLgUp) return;
    const observer = new IntersectionObserver(
      ([entry]) => setSignerPaneVisible(Boolean(entry?.isIntersecting)),
      { threshold: 0.15 }
    );
    observer.observe(pane);
    return () => observer.disconnect();
  }, [isLgUp, step, review]);
  const [placementVisiblePage, setPlacementVisiblePage] = useState(1);
  const [placementPageCount, setPlacementPageCount] = useState<number | null>(null);
  /** What's typed in the toolbar's page box while it has focus (`null` = not
   * editing, show the visible page). Keeps the box editable -- it used to be
   * bound straight to the visible page, so every keystroke snapped back. */
  const [pageInputDraft, setPageInputDraft] = useState<string | null>(null);
  const commitPageInput = () => {
    const value = Number(pageInputDraft);
    if (pageInputDraft && Number.isFinite(value) && value >= 1) {
      signaturePlacementRef.current?.goToPage(value);
    }
    setPageInputDraft(null);
  };
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
  /** True while the silent existing-signature check below is in flight, so
   * the left pane can show a "verifying" spinner instead of nothing. */
  const [checkingSignatures, setCheckingSignatures] = useState(false);

  // A round that ended without a signature (rejected/expired/failed) stays on
  // step 3 -- "Nhận tệp PDF đã ký" was never reached.
  const signFailed = step === 'done' && status !== 'SIGNED';
  const currentStepIndex =
    (step === 'done' && !signFailed) || review ? 3 : step === 'scan' || signFailed ? 2 : file ? 1 : 0;
  const steps = useMemo(
    () => DISPLAY_STEP_KEYS.map((key) => ({ key, label: t(`home.steps.${key}.title`) })),
    [t]
  );
  const progressLabel = t('steps.progressLabel', {
    current: currentStepIndex + 1,
    total: steps.length,
  });

  // Resume an IN-PROGRESS session from this tab's sessionStorage on mount. A terminal
  // session is never resumed this way any more — it gets cleared the moment
  // it becomes terminal (see the polling effect below), so there is nothing
  // left to resume; reloading after that just starts fresh — EXCEPT a
  // still-unexpired identityKey from a just-finished SIGNED round, which is
  // kept specifically so "Tiếp tục ký"/"Tải lại" work even after a reload.
  useEffect(() => {
    const savedId = getSessionItem(LS_KEYS.signRequestId);
    const savedStatus = getSessionItem(LS_KEYS.status);
    // Deliberate one-time resume from sessionStorage (browser-only) after mount
    // — a lazy useState initializer would run during SSR too and mismatch on
    // hydration, so a mount effect is the correct pattern here.
    if (savedId && savedStatus && !TERMINAL_STATUSES.has(savedStatus)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSignRequestId(savedId);
      setQrContent(getSessionItem(LS_KEYS.qrContent));
      setStep('scan');
      setQrDialogOpen(true);
      // The document itself (kept in IndexedDB at submit) so the locked
      // workspace behind the QR popup still shows it after a reload.
      const savedName = getSessionItem(LS_KEYS.documentName) || 'document.pdf';
      // ...and the boxes that were sent, from the round's recent-list entry.
      setSignatureFields(
        validStoredFields(
          getRecentSignatures().find((e) => e.code === pendingCode(savedId))?.signatureFields
        )
      );
      void getSignedPdf(pendingCode(savedId)).then((blob) => {
        if (blob) setFile(new File([blob], savedName, { type: 'application/pdf' }));
      });
      return;
    }

    // A recent round opened from the home page is now the session on
    // screen (F5 reopens it). A plain file from the home page starts fresh.
    if (initialReview) {
      setActiveSession({ kind: 'signed', code: initialReview.code, name: initialReview.name });
      return;
    }
    if (initialFile) return;

    // Reload while a result was on screen: reopen that same session.
    const active = getActiveSession();
    if (active) {
      void getSignedPdf(active.code).then((blob) => {
        if (!blob) {
          clearActiveSession();
          return;
        }
        setFile(new File([blob], active.name, { type: 'application/pdf' }));
        if (active.kind === 'signed') {
          const entry = getRecentSignatures().find((e) => e.code === active.code);
          setReview(
            entry ?? { code: active.code, name: active.name, signedAt: new Date().toISOString() }
          );
        } else {
          setStatus(active.status ?? 'FAILED');
          setSignatureFields(validStoredFields(active.signatureFields));
          setStep('done');
        }
      });
      return;
    }

    const savedIdentityKey = getSessionItem(LS_KEYS.identityKey);
    const savedExpiresAt = getSessionItem(LS_KEYS.identityKeyExpiresAt);
    // Deliberately does NOT auto-fetch the signed PDF here — that would spend
    // one of identityKey's ~5 CAS uses on every single reload. Only the
    // buttons show; a fetch happens only once the user actually clicks one.
    if (savedIdentityKey && savedExpiresAt && new Date(savedExpiresAt).getTime() > Date.now()) {
      setStatus('SIGNED');
      setStep('done');
    }
  }, [initialFile, initialReview]);

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
    if (!file) {
      // Reset is intentionally synchronous: this effect exists specifically
      // to keep existingSignatures in sync with file/step, so there is no
      // "external system" to defer to here.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExistingSignatures([]);
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
        // Shown in the always-visible left pane ("Lịch sử ký").
        setExistingSignatures(signatures);
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
  }, [file]);

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
    setReview(null);
    setFile(selected);
    setSignatureFields([]);
    setSignerConfigJustRevealed(false);
  };

  /** "Xoá tệp" in the signer pane: back to an empty placement step (the
   * dropzone shows again in the PDF area) without leaving the wizard. */
  const handleRemoveFile = () => {
    clearActiveSession();
    setReview(null);
    setFile(null);
    setSignatureFields([]);
    setSignerConfigJustRevealed(false);
    setUploadError(null);
  };

  // Shared by the empty dropzone and the loaded-file card (dropping a PDF
  // on the card swaps the file).
  const fileDropHandlers = {
    onDragEnter: (e: DragEvent) => {
      e.preventDefault();
      setDragCounter((prev) => prev + 1);
    },
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: DragEvent) => {
      e.preventDefault();
      setDragCounter((prev) => Math.max(0, prev - 1));
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragCounter(0);
      handleFileSelected(e.dataTransfer.files?.[0] ?? null);
    },
  };

  // The 3-pane workspace stays on screen for the whole round: placing boxes
  // (upload), waiting for the signer behind the QR popup (scan) and a round
  // that ended without a signature. Only a plain successful "done" (signed
  // PDF couldn't be loaded into the workspace) uses the old Done screen.
  const showWorkspace = step === 'upload' || step === 'scan' || signFailed;
  // Once "Ký" is pressed the placement is frozen: no adding/moving/removing
  // boxes until the user starts a new request.
  const locked = step !== 'upload';
  const showToolbarControls = showWorkspace && Boolean(file);

  // The left pane's "Vị trí ký vừa thêm" list -- numbered exactly like the
  // boxes on the PDF (fieldOrdinals), listed in that order.
  const placedFieldItems = useMemo(() => {
    const ordinals = fieldOrdinals(signatureFields);
    return signatureFields
      .map((field, index) => ({ index, ordinal: ordinals[index] ?? index + 1, page: field.page }))
      .sort((x, y) => x.ordinal - y.ordinal);
  }, [signatureFields]);

  // 3 panes, always: signature history (existing signatures + boxes placed
  // so far) on the left, the PDF, the signer pane on the right.
  const gridColsClassName =
    'lg:grid-cols-[minmax(260px,0.48fr)_minmax(0,1.62fr)_minmax(320px,0.5fr)]';

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

      setSessionItem(LS_KEYS.signRequestId, data.signRequestId);
      setSessionItem(LS_KEYS.status, 'NEW');
      setSessionItem(LS_KEYS.documentName, file.name);
      setSessionItem(LS_KEYS.createdAt, new Date().toISOString());
      setSessionItem(LS_KEYS.qrContent, data.qrContent);

      // Listed on the home page as "Đang chờ ký" right away, with its file
      // kept locally so the waiting screen survives a reload.
      const code = pendingCode(data.signRequestId);
      void saveSignedPdf(code, file);
      addRecentSignature({
        code,
        status: 'pending',
        signatureFields,
        name: file.name,
        signedAt: new Date().toISOString(),
        signRequestId: data.signRequestId,
        qrContent: data.qrContent,
      });
      clearActiveSession();

      setSignRequestId(data.signRequestId);
      setQrContent(data.qrContent);
      setStatus('PENDING');
      setStep('scan');
      setQrDialogOpen(true);
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
    async (
      identityKey: string,
      code?: string | null
    ): Promise<{ url: string; blob: Blob } | null> => {
      const blob = await downloadSignedPdfBlob(identityKey);
      if (!blob) return null;
      // Keep a browser-local copy for the home page's recent list, so
      // reopening this round there doesn't spend another CAS download.
      if (code) {
        // Stored locally -> the download key is no longer needed; don't
        // leave a bearer credential for the signed file lying around.
        void saveSignedPdf(code, blob).then(() => {
          forgetIdentityKey(code);
          removeSessionItem(LS_KEYS.identityKey);
          removeSessionItem(LS_KEYS.identityKeyExpiresAt);
          return pruneStoredPdfs();
        });
      }
      const url = URL.createObjectURL(blob);
      setSignedPdfUrl(url);
      setShowDownloadReminder(true);
      return { url, blob };
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
        if (data.expiresIn) {
          const expiry = new Date(Date.now() + data.expiresIn * 1000).toISOString();
          setExpiresAt(expiry);
          // Once, so the home page can drop the "Đang chờ ký" chip by itself
          // when the QR has expired.
          const pending = getRecentSignatures().find((e) => e.code === pendingCode(signRequestId));
          if (pending && !pending.expiresAt) {
            updateRecentSignature(pending.code, { expiresAt: expiry });
          }
        }

        if (TERMINAL_STATUSES.has(data.status)) {
          if (data.status === 'SIGNED' && data.identityKey) {
            // Keep identityKey (+ its CAS expiry, + documentName) a little
            // longer on purpose — everything else about this round is done
            // and clears immediately as before (explicit product
            // requirement), but this lets "Tiếp tục ký"/"Tải lại" keep
            // working even after a reload (see the mount effect above).
            clearRoundKeepPendingIdentity();
            setSessionItem(LS_KEYS.identityKey, data.identityKey);
            if (data.identityKeyExpiresAt) {
              setSessionItem(LS_KEYS.identityKeyExpiresAt, data.identityKeyExpiresAt);
            }
            if (data.orgIdSigned) {
              setOrgIdSigned(data.orgIdSigned);
              // Feeds the home page's "5 phiên ký gần nhất" list -- same
              // documentName fallback convention as handleContinueSigning.
              // Takes over the round's "Đang chờ ký" entry in place.
              replaceRecentSignature(pendingCode(signRequestId), {
                code: data.orgIdSigned,
                status: 'signed',
                name: getSessionItem(LS_KEYS.documentName) || 'signed.pdf',
                signedAt: new Date().toISOString(),
                identityKey: data.identityKey,
                identityKeyExpiresAt: data.identityKeyExpiresAt,
              });
            }
          } else {
            // Nothing left to resume once terminal — clear right away so a
            // fresh signing session can start immediately (explicit product
            // requirement), independent of whether the user ever reloads.
            const name = getSessionItem(LS_KEYS.documentName) || 'document.pdf';
            clearPersistedSession();
            rememberFailedRound(signRequestId, data.status, name);
            setFailedNoticeOpen(true);
          }
          setQrDialogOpen(false);
          if (data.status === 'SIGNED' && data.identityKey && data.orgIdSigned) {
            // Refresh the workspace in place with the signed PDF (review
            // mode: "Ký thành công", code, "Tải tài liệu về"/"Ký tiếp"). The
            // status pane says "finishing" meanwhile; if the download fails
            // the old Done screen (with its retry buttons) takes over.
            const signedEntry: RecentSignature = {
              code: data.orgIdSigned,
              status: 'signed',
              name: getSessionItem(LS_KEYS.documentName) || 'signed.pdf',
              signedAt: new Date().toISOString(),
              identityKey: data.identityKey,
              identityKeyExpiresAt: data.identityKeyExpiresAt ?? undefined,
            };
            void fetchSignedPdfOnce(data.identityKey, data.orgIdSigned).then((fetched) => {
              if (!fetched) {
                setStep('done');
                return;
              }
              setFile(new File([fetched.blob], signedEntry.name, { type: 'application/pdf' }));
              setReview(signedEntry);
              setActiveSession({ kind: 'signed', code: signedEntry.code, name: signedEntry.name });
              setSignatureFields([]);
              setStep('upload');
            });
          } else {
            setStep('done');
          }
          return;
        }
        setSessionItem(LS_KEYS.status, data.status);
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
   * without re-uploading. Must still clear the stored round (not just state) --
   * otherwise a reload right after going back would hit the mount-only
   * resume effect above and jump straight back into 'scan' with the very
   * request the user just walked away from. */
  const handleBackToPlacement = useCallback(() => {
    clearPersistedSession();
    // Waiting round abandoned ("Ký yêu cầu mới") -> off the recent list;
    // a failed one ("Ký lại") is no longer the session on screen.
    if (signRequestId) removeRecentSignature(pendingCode(signRequestId));
    clearActiveSession();
    pruneStoredPdfs();
    setQrDialogOpen(false);
    setFailedNoticeOpen(false);
    setSignRequestId(null);
    setQrContent(null);
    setExpiresAt(null);
    setStatus(null);
    setStatusError(null);
    setOrgIdSigned(null);
    setSubmitError(null);
    setStep('upload');
  }, [signRequestId]);

  /** QR countdown hit 0 before the signer confirmed: the round is over --
   * same result screen as a polled EXPIRED (leaving the scan step also stops
   * the polling). */
  const handleQrExpired = useCallback(() => {
    const name = getSessionItem(LS_KEYS.documentName) || file?.name || 'document.pdf';
    clearPersistedSession();
    rememberFailedRound(signRequestId, 'EXPIRED', name);
    setQrDialogOpen(false);
    setFailedNoticeOpen(true);
    setStatus('EXPIRED');
    setStep('done');
  }, [signRequestId, file]);

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
    // A waiting round stays on the home page's recent list (resumable from
    // there); only the on-screen session is forgotten.
    clearPersistedSession();
    clearActiveSession();
    setFailedNoticeOpen(false);
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
      a.download = signedFileName(getSessionItem(LS_KEYS.documentName));
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
    const savedIdentityKey = getSessionItem(LS_KEYS.identityKey);
    if (!savedIdentityKey) return;
    const fetched = await fetchSignedPdfOnce(savedIdentityKey, orgIdSigned);
    if (fetched) triggerDownload(fetched.url);
  }, [signedPdfUrl, triggerDownload, fetchSignedPdfOnce, orgIdSigned]);

  /** "Tiếp tục ký" — chain a new signing round onto the just-signed PDF.
   * Re-downloads the signed bytes via the persisted identityKey (spending
   * one more of its ~5 uses — the trade-off of not holding the file in
   * IndexedDB), wraps them into a fresh File, and hands the wizard back to
   * the placement step exactly like a fresh upload would (see
   * HomeLanding's initialFile hand-off — same mechanism). Deliberately keeps
   * signerConfig (a re-signer is usually the same person/entity). */
  const handleContinueSigning = useCallback(async () => {
    const savedIdentityKey = getSessionItem(LS_KEYS.identityKey);
    if (!savedIdentityKey) return;
    const savedName = getSessionItem(LS_KEYS.documentName) || 'signed.pdf';

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

  // Review mode (a recent round reopened from the home page): CAS's own
  // record of the round (signer, method, time) for the right pane, fetched
  // once per code. Purely informational -- on failure that part just hides.
  type ReviewRoundState =
    | { code: string; kind: 'loading' }
    | { code: string; kind: 'error' }
    | { code: string; kind: 'result'; data: SigningRoundDetail };
  const [reviewRound, setReviewRound] = useState<ReviewRoundState | null>(null);
  const reviewCode = review?.code ?? null;
  useEffect(() => {
    if (!reviewCode) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReviewRound({ code: reviewCode, kind: 'loading' });
    void lookupSigningRound(reviewCode).then((result) => {
      if (cancelled) return;
      setReviewRound(
        result.ok
          ? { code: reviewCode, kind: 'result', data: result.data }
          : { code: reviewCode, kind: 'error' }
      );
    });
    return () => {
      cancelled = true;
    };
  }, [reviewCode]);
  const currentReviewRound = reviewRound?.code === reviewCode ? reviewRound : null;

  const [reviewCodeCopied, setReviewCodeCopied] = useState(false);
  const handleCopyReviewCode = async () => {
    if (!review) return;
    try {
      await navigator.clipboard.writeText(review.code);
      setReviewCodeCopied(true);
      setTimeout(() => setReviewCodeCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; the code is visible right there.
    }
  };

  /** "Tải tài liệu về": the signed PDF is already here (it's the file on
   * screen), so no CAS download is spent. */
  const handleReviewDownload = () => {
    if (!file || !review) return;
    triggerBlobDownload(file, signedFileName(review.name));
  };

  /** "Ký tiếp": leave review mode and place new boxes on this same signed
   * file -- the normal placement step, nothing re-downloaded. */
  const handleReviewContinueSigning = () => {
    // The previous round is finished with; a new one starts from here (its
    // signed copy stays in the home page's recent list).
    clearPersistedSession();
    clearActiveSession();
    setStatus(null);
    setOrgIdSigned(null);
    setReview(null);
    setSignatureFields([]);
    setSignerConfigJustRevealed(false);
  };

  /** "Ký tài liệu mới" (after a signed or failed round): back to the empty
   * upload area in the workspace. Keeps the signer's CCCD/MST. */
  const handleSignNewDocument = () => {
    clearPersistedSession();
    clearActiveSession();
    pruneStoredPdfs();
    setQrDialogOpen(false);
    setFailedNoticeOpen(false);
    setReview(null);
    setFile(null);
    setSignatureFields([]);
    setSignerConfigJustRevealed(false);
    setUploadError(null);
    setSignRequestId(null);
    setQrContent(null);
    setExpiresAt(null);
    setStatus(null);
    setStatusError(null);
    setOrgIdSigned(null);
    setSubmitError(null);
    setStep('upload');
  };

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

        {/* Step row: just the compact step indicator, centered, lg+ only
            (it's hidden below lg -- no room -- where each step shows its
            own SigningStepHeader instead). The PDF controls that used to
            share this row now sit in a toolbar right above the PDF, and the
            old "Lịch sử ký" toggle is gone (the history pane is always
            shown). Rendered on every step so the indicator stays visible. */}
        <div className="hidden border-b border-border-subtle bg-white/95 backdrop-blur lg:block">
          <div className="flex w-full justify-center px-4 pb-3.5 pt-2 sm:px-6">
            <HeaderSteps steps={steps} currentStepIndex={currentStepIndex} />
          </div>
        </div>
      </div>

      <main className="flex min-w-0 flex-1 flex-col">
        <div
          className="flex w-full flex-1 flex-col px-4 py-4 sm:px-6 sm:py-5"
        >
          {showWorkspace && (
            // Wide screens (lg+): a fixed, viewport-sized workspace of 3
            // panes -- the page itself doesn't scroll, each pane scrolls on
            // its own (see WorkspacePane), so the wheel only moves the pane
            // under the pointer. Height = viewport minus the measured sticky
            // header, this section's own bottom margin (mb-4; no top margin at
            // lg -- <main>'s own padding is the gap under the step row) and <main>'s
            // vertical padding (sm:py-5). Below lg the panes stack and the
            // page keeps its single ordinary scroll.
            // No SigningCard/step header around the panes on lg+ (too many
            // nested frames, per explicit request) -- the header's step
            // indicator already says which step this is. That indicator is
            // hidden below lg, so the step header stays there.
            <section
              className="mb-4 mt-2 flex flex-col lg:mt-0 lg:h-[calc(100svh-var(--sticky-offset)-3.5rem)]"
              style={{ '--sticky-offset': `${stickyOffset}px` } as CSSProperties}
            >
              <div className="lg:hidden">
                <SigningStepHeader
                  stepNumber={currentStepIndex + 1}
                  title={steps[currentStepIndex]!.label}
                  trailingContent={progressLabel}
                />
              </div>
              <div
                className={`grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-rows-[minmax(0,1fr)] ${gridColsClassName}`}
              >
                <WorkspacePane
                  title={t('signatureHistory.title')}
                  icon="lucide:history"
                  className="max-lg:order-2"
                >
                  <SignatureHistorySidebar
                    signatures={existingSignatures}
                    checking={checkingSignatures}
                    fields={placedFieldItems}
                    showNewFields={!review && !signFailed}
                    readOnly={locked}
                    onFocusField={(index) => signaturePlacementRef.current?.focusField(index)}
                    onRemoveField={(index) => signaturePlacementRef.current?.removeField(index)}
                  />
                </WorkspacePane>

                {/* PDF pane: no frame/title of its own (per explicit request
                    -- just the PDF, whose gray stage is the visual). Still its
                    own scroll container at lg+, handed to SignaturePlacement
                    as `scrollRoot`. */}
                <div className="flex min-w-0 flex-col gap-2 max-lg:order-1 lg:min-h-0">
                  {/* PDF toolbar (page nav, zoom, "Chọn vị trí ký", field
                      counter), right above the PDF -- moved down from the
                      header row, so the controls sit next to what they act
                      on. Outside the scroll container so it never scrolls
                      away on wide screens; on phones (page scroll) it sticks
                      just under the sticky header. */}
                  {showToolbarControls && (
                    <div
                      className="flex shrink-0 flex-wrap items-center justify-between gap-2 overflow-x-clip py-1 max-lg:sticky max-lg:z-20 max-lg:bg-white/95 max-lg:backdrop-blur"
                      style={isLgUp ? undefined : { top: stickyOffset }}
                    >
                    {/* Neutral/white -- deliberately NOT the green `bg-primary`
                        treatment, so only "Chọn vị trí ký" and "Ký" (the actual
                        primary actions) read as green/highlighted; page-nav/zoom
                        stay small/secondary. */}
                    <div className="flex items-center gap-1 rounded-full border border-border-subtle bg-white px-2 py-0.5 text-xs text-text-secondary shadow-sm">
                      {/* Typing only edits a local draft; Enter/blur jumps
                          (out-of-range numbers are clamped by goToPage), Esc
                          cancels. */}
                      <input
                        type="text"
                        inputMode="numeric"
                        value={pageInputDraft ?? String(placementVisiblePage)}
                        onFocus={(e) => {
                          setPageInputDraft(String(placementVisiblePage));
                          e.currentTarget.select();
                        }}
                        onChange={(e) => setPageInputDraft(e.currentTarget.value.replace(/\D/g, ''))}
                        onBlur={commitPageInput}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur();
                          } else if (e.key === 'Escape') {
                            const input = e.currentTarget;
                            setPageInputDraft(null);
                            // Blur after the draft is dropped, so onBlur commits nothing.
                            requestAnimationFrame(() => input.blur());
                          }
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
                        className="flex h-7 w-7 items-center justify-center rounded-full text-text-main hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Icon icon="lucide:minus" className="h-4 w-4" />
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
                        className="flex h-7 w-7 items-center justify-center rounded-full text-text-main hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <Icon icon="lucide:plus" className="h-4 w-4" />
                      </button>
                    </div>
                    {/* No ping/pulse animation any more (per explicit
                        request) -- a plain primary button. */}
                    {!review && !locked && (
                    <button
                      type="button"
                      onClick={() => signaturePlacementRef.current?.addField()}
                      disabled={!placementCanAddField}
                      className="ml-auto inline-flex items-center justify-center whitespace-nowrap rounded-full bg-primary px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {t('sign.addField')}
                    </button>
                    )}
                    </div>
                  )}
                  <div
                    ref={setPdfScrollEl}
                    className="min-w-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain"
                  >
                  {file ? (
                    <SignaturePlacement
                      ref={signaturePlacementRef}
                      file={file}
                      // A round that ended without a signature doesn't show
                      // its old boxes (they come back with "Ký lại").
                      fields={signFailed ? NO_FIELDS : signatureFields}
                      onFieldsChange={setSignatureFields}
                      onVisiblePageChange={setPlacementVisiblePage}
                      onPageCountChange={setPlacementPageCount}
                      onZoomFactorChange={setPlacementZoomFactor}
                      onCanAddFieldChange={setPlacementCanAddField}
                      topInset={stickyOffset}
                      scrollRoot={isLgUp ? pdfScrollEl : null}
                      disabled={locked}
                    />
                  ) : (
                    // No file yet (or it was removed): the upload dropzone
                    // fills the PDF area, right where the document will show.
                    <div className="flex flex-col gap-3 lg:h-full">
                      {/* Hidden input behind the dropzone (via htmlFor).
                          Cleared after each pick so choosing the same file
                          again (e.g. after "Xoá tệp") still fires onChange. */}
                      <input
                        id="file-input"
                        type="file"
                        accept="application/pdf"
                        onChange={(e) => {
                          handleFileSelected(e.target.files?.[0] ?? null);
                          e.target.value = '';
                        }}
                        className="sr-only"
                      />
                      <label
                        htmlFor="file-input"
                        className={`flex min-h-[360px] w-full flex-1 cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
                          dragCounter > 0
                            ? 'border-primary bg-surface-soft-strong ring-2 ring-primary/40'
                            : 'border-primary/50 bg-surface-soft hover:border-primary hover:bg-surface-soft-strong'
                        }`}
                        {...fileDropHandlers}
                      >
                        <span className="flex text-primary-strong">
                          <Icon icon="lucide:file-check-2" className="h-14 w-14" />
                        </span>
                        <p className="text-xl font-semibold text-text-main">{t('upload.title')}</p>
                        <p className="text-sm text-text-muted">{t('upload.dropHint')}</p>
                        <span className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-white shadow-sm shadow-primary/40 transition-colors hover:bg-primary-strong">
                          {t('common.upload')}
                        </span>
                        <p className="text-xs text-text-soft">
                          {t('upload.requirements', { maxMb: MAX_SIGN_UPLOAD_SIZE_MB })}
                        </p>
                        <p className="mt-1 text-xs text-text-soft">{t('upload.noFile')}</p>
                      </label>
                      {uploadError && (
                        <div className="rounded-md border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text">
                          {uploadError}
                        </div>
                      )}
                    </div>
                  )}
                  </div>
                </div>

                {/* Signer pane (file + signer details), RIGHT of the PDF.
                    Phones stack PDF -> history -> this pane (explicit
                    request); the floating pen button below jumps here.
                    scroll-mt keeps its top clear of the sticky header. */}
                <WorkspacePane
                  paneRef={signerPaneRef}
                  title={t('workspace.signerPane')}
                  icon="lucide:user-pen"
                  className="max-lg:order-3 max-lg:scroll-mt-[calc(var(--sticky-offset)+0.75rem)]"
                  bodyClassName="flex flex-col gap-4"
                >
                  {locked && !review ? (
                    <SigningStatusPane
                      file={file}
                      pageCount={placementPageCount}
                      // SIGNED here = the signed PDF is still being loaded
                      // into the workspace: show it as "finishing".
                      status={status === 'SIGNED' ? 'ACCEPTED' : status}
                      expiresAt={expiresAt}
                      onExpired={handleQrExpired}
                      onReopenQr={() => setQrDialogOpen(true)}
                      onNewRequest={handleBackToPlacement}
                      onSignNewDocument={handleSignNewDocument}
                    />
                  ) : review && file ? (
                    <ReviewSignedPane
                      file={file}
                      pageCount={placementPageCount}
                      review={review}
                      round={
                        !currentReviewRound || currentReviewRound.kind === 'loading'
                          ? null
                          : currentReviewRound.kind === 'error'
                            ? 'error'
                            : currentReviewRound.data
                      }
                      codeCopied={reviewCodeCopied}
                      onCopyCode={() => void handleCopyReviewCode()}
                      onViewDetails={(data) => setVerifyPopup({ kind: 'result', data })}
                      onDownload={handleReviewDownload}
                      onContinueSigning={handleReviewContinueSigning}
                      onRemoveFile={handleRemoveFile}
                      onSignNewDocument={handleSignNewDocument}
                    />
                  ) : (
                  <>
                  {file ? (
                    // A file is loaded: a compact row -- PDF icon, name,
                    // size · page count, and an X to remove it (the
                    // dropzone shows again in the PDF area). Dropping a PDF
                    // onto this card still swaps the file.
                    <div
                      className={`flex shrink-0 items-center gap-3 rounded-xl border bg-white px-3 py-3 transition ${
                        dragCounter > 0
                          ? 'border-primary ring-2 ring-primary/40'
                          : 'border-border-subtle'
                      }`}
                      {...fileDropHandlers}
                    >
                      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-red-50 text-red-500">
                        <Icon icon="lucide:file-text" className="h-6 w-6" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div
                          className="truncate text-sm font-semibold text-text-main"
                          title={file.name}
                        >
                          {file.name}
                        </div>
                        <div className="mt-0.5 text-xs text-text-muted">
                          {formatFileSize(file.size)}
                          {placementPageCount
                            ? ` · ${t('upload.pageCount', { count: placementPageCount })}`
                            : ''}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={handleRemoveFile}
                        aria-label={t('upload.removeFile')}
                        title={t('upload.removeFile')}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-gray-100 hover:text-text-main"
                      >
                        <Icon icon="lucide:x" className="h-5 w-5" />
                      </button>
                    </div>
                  ) : (
                    // No file: the dropzone is in the PDF area now, so this
                    // pane only says what comes next.
                    <div className="rounded-xl border border-dashed border-border-subtle px-3 py-3 text-xs">
                      <p className="font-semibold text-text-main">{t('upload.uploadPreview')}</p>
                      <p className="mt-1 text-text-muted">{t('sign.needUploadForPreview')}</p>
                    </div>
                  )}

                  {file && uploadError && (
                    <div className="rounded-md border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text">
                      {uploadError}
                    </div>
                  )}

                  {hasSignatureFields ? (
                    <>
                      {/* Next-step cue after a field is placed: a pulsing
                          ring on its own overlay (pulsing the box itself
                          would fade the inputs too), for 6 s or until the
                          user starts filling it in. */}
                      <div
                        className="relative rounded-xl border border-border-subtle bg-surface-soft px-3 py-2.5"
                        onFocusCapture={() => setSignerConfigJustRevealed(false)}
                      >
                        {signerConfigJustRevealed && (
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute -inset-1 animate-pulse rounded-xl ring-2 ring-primary"
                          />
                        )}
                        <SignerConfigPanel value={signerConfig} onChange={setSignerConfig} />
                      </div>

                      {/* The ripple is box-shadow based (`animate-ky-ripple`,
                          app/globals.css) so it can't cause horizontal
                          scroll. */}
                      <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                        className={`inline-flex w-full shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full bg-primary px-6 py-2.5 text-base font-semibold text-white shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60 ${
                          canSubmit ? 'animate-ky-ripple' : ''
                        }`}
                      >
                        {submitting && <ButtonSpinner />}
                        {submitting ? t('common.submitting') : t('sign.submit')}
                      </button>
                    </>
                  ) : (
                    file && (
                      <p className="flex items-start gap-2 rounded-xl border border-dashed border-border-subtle px-3 py-2.5 text-xs text-text-muted">
                        <Icon icon="lucide:info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {t('sign.placeFieldFirstHint')}
                      </p>
                    )
                  )}
                  </>
                  )}
                </WorkspacePane>
              </div>
            </section>
          )}

          {step === 'done' && !signFailed && (
            <section>
              <SigningCard>
                {/* Custom 3-slot header row (title / centered buttons /
                      progress label) instead of SigningStepHeader's plain
                      2-slot title+trailing layout -- that component's own
                      `justify-between` only ever pins trailingContent to the
                      far right, it can't center it in the remaining space.
                      Mirrors the same left/center/right pattern already used
                      for the site Header's logo/steps/right-controls row.
                      The 4 action buttons (+ "Bước 4/4") share this row
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
                      4
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
                {status === 'SIGNED' && (
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
                            {/* On lg+, viewport minus the measured sticky
                                header minus everything from this wrapper's
                                top edge to the page bottom: 4.25rem = this
                                wrapper's `sm:p-3` top + bottom (1.5rem) +
                                the card's `sm:p-6` bottom (1.5rem) + <main>'s
                                `sm:py-5` bottom (1.25rem). Subtracting less
                                lets the page scroll the PDF viewer's own
                                toolbar (zoom etc.) under the sticky header,
                                out of reach -- update this if those paddings
                                change. Passed as a CSS var so it still only
                                applies from `lg` up. */}
                            <iframe
                              src={signedPdfUrl}
                              title={t('done.signedPdfTitle')}
                              style={{ '--sticky-offset': `${stickyOffset}px` } as CSSProperties}
                              className="h-[65vh] w-full rounded-lg bg-white lg:h-[calc(100svh-var(--sticky-offset)-4.25rem)]"
                            />
                          </div>
                        )
                      )}
                    </div>
                  </div>
                )}
              </SigningCard>
            </section>
          )}
        </div>
      </main>

      {step === 'scan' && qrDialogOpen && (
        <QrSignDialog
          qrContent={qrContent}
          expiresAt={expiresAt}
          onExpired={handleQrExpired}
          status={status}
          statusError={statusError}
          onSyncStatus={() => void handleSyncStatus()}
          onCopyLink={handleCopyQrLink}
          linkCopied={qrLinkCopied}
          onClose={() => setQrDialogOpen(false)}
        />
      )}

      {!isLgUp && step === 'upload' && !review && signatureFields.length > 0 && !signerPaneVisible && (
        <button
          type="button"
          onClick={() => signerPaneRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          aria-label={t('sign.goToSignerPane')}
          title={t('sign.goToSignerPane')}
          className="fixed bottom-5 right-4 z-30 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-white shadow-lg shadow-primary/40 transition hover:bg-primary-strong lg:hidden"
        >
          <Icon icon="lucide:pen-line" className="h-5 w-5" />
        </button>
      )}

      {signFailed && failedNoticeOpen && (
        <SignFailedModal
          status={status}
          onRetry={handleBackToPlacement}
          onSignNewDocument={handleSignNewDocument}
          onClose={() => setFailedNoticeOpen(false)}
        />
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
