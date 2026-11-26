'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import Header from './Header';
import Footer from './Footer';
import { SIGNING_METHODS_SECTION_ID, SigningMethodsSection } from './home/SigningMethodsSection';
import { ScrollCue } from './ScrollCue';
import { CasIdVideoGuide } from './signing/CasIdVideoGuide';
import { LANDING_GUIDE_VIDEO_EMBED_URL } from '@/lib/branding/signingMethods';
import { ButtonSpinner } from './signing/Spinners';
import { MAX_SIGN_UPLOAD_SIZE_MB } from './signing/constants';
import {
  forgetIdentityKey,
  getRecentSignatures,
  isPendingSignature,
  type RecentSignature,
} from '@/lib/recentSignatures';
import { downloadSignedPdfBlob, signedFileName, triggerBlobDownload } from '@/lib/downloadSignedPdf';
import { getSignedPdf, saveSignedPdf } from '@/lib/signedPdfStore';
import { cleanupBrowserStorage, clearBrowserHistory } from '@/lib/browserHistory';
import { SESSION_KEYS, removeSessionItem, setSessionItem } from '@/lib/signingSessionStorage';

const SUPPORTED_FILE_FORMATS = ['PDF'];

/**
 * Ported from x-sign-web/src/features/home/HomePage.tsx. Adapted for the new
 * stateless architecture: the original called a separate `POST
 * /documents/upload` and navigated to `/request-signing/:documentId` on
 * success — there is no such separate upload step any more (upload +
 * placement + dispatch is a single request now), so a dropped/selected file
 * here is just validated locally and handed straight to the wizard view
 * (client-side, no network round-trip yet).
 *
 * Looking up a signing round and verifying an already-signed PDF both live
 * on `/verify`. A recent-signature chip opens that round's signed PDF in the
 * signing wizard (review mode) when the PDF is still obtainable, else falls
 * back to `/verify`.
 */
export function HomeLanding({
  onFileAccepted,
  onRecentOpened,
  onResumePending,
}: {
  onFileAccepted: (file: File) => void;
  onRecentOpened: (file: File, entry: RecentSignature) => void;
  /** A "Đang chờ ký" entry was clicked: its round is primed in sessionStorage
   * and the wizard resumes it (QR popup, polling, file from IndexedDB). */
  onResumePending: () => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const [dragCounter, setDragCounter] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const signCardRef = useRef<HTMLDivElement>(null);

  // Reading `getRecentSignatures()` directly during render (or even as a
  // `useState` lazy initializer) would return `[]` on the server but the
  // real, populated list on the client's very first render -- a hydration
  // mismatch (React requires the client's first render to match the
  // server's exactly, not just "not crash"; `getRecentSignatures()` being
  // SSR-*safe*, i.e. non-throwing, doesn't make it SSR-*consistent*). A
  // mount effect defers this until after that first render/hydration is
  // already committed, matching the same pattern this codebase already
  // uses for `SigningWizard.tsx`'s own `existingSignatures`.
  const [recentSignatures, setRecentSignatures] = useState<RecentSignature[]>([]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecentSignatures(getRecentSignatures());
    // Housekeeping on every visit: drop entries past the 7-day TTL, pending
    // rounds whose QR expired, expired download keys, and PDFs nothing
    // refers to any more (lib/browserHistory.ts).
    void cleanupBrowserStorage().then(() => setRecentSignatures(getRecentSignatures()));
  }, []);
  /** "Xoá lịch sử": first click asks, second one clears. */
  const [confirmingClear, setConfirmingClear] = useState(false);
  const handleClearHistory = async () => {
    await clearBrowserHistory();
    setConfirmingClear(false);
    setRecentDownloadError(null);
    setRecentSignatures([]);
  };
  const [recentDownloadError, setRecentDownloadError] = useState<string | null>(null);
  const [downloadingCode, setDownloadingCode] = useState<string | null>(null);
  const [openingCode, setOpeningCode] = useState<string | null>(null);

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
    setValidating(true);
    onFileAccepted(selected);
  };

  /** The signed PDF of a recent round: the copy kept in this browser first
   * (no CAS download spent), else via identityKey -- then kept locally and
   * the key forgotten. Throws if neither is available. */
  const loadSignedPdf = async (entry: RecentSignature): Promise<Blob> => {
    const stored = await getSignedPdf(entry.code);
    if (stored) return stored;
    if (!entry.identityKey) throw new Error('no local copy and no download key');
    const blob = await downloadSignedPdfBlob(entry.identityKey);
    await saveSignedPdf(entry.code, blob);
    forgetIdentityKey(entry.code);
    return blob;
  };

  const handleDownloadRecent = async (entry: RecentSignature) => {
    setDownloadingCode(entry.code);
    setRecentDownloadError(null);
    try {
      const blob = await loadSignedPdf(entry);
      triggerBlobDownload(blob, signedFileName(entry.name));
    } catch (err) {
      console.warn('[home] recent-signature download failed', err);
      setRecentDownloadError(t('home.recentSignatures.downloadError'));
    } finally {
      setDownloadingCode(null);
    }
  };

  /** Open a recent round in the signing wizard. The signed PDF comes from
   * the browser-local copy saved when it was signed; failing that, from CAS
   * via identityKey while it's still valid (spends 1 of its ~5 downloads,
   * then saved locally so it's only spent once). With neither, fall back to
   * the round lookup on `/verify` as before. */
  const handleViewRecent = async (entry: RecentSignature) => {
    if (openingCode) return;
    if (isPendingSignature(entry)) {
      if (!entry.signRequestId) return;
      // Same keys SigningWizard persists a waiting round under -- its mount
      // effect then resumes it exactly like after a reload.
      setSessionItem(SESSION_KEYS.signRequestId, entry.signRequestId);
      setSessionItem(SESSION_KEYS.status, 'PENDING');
      setSessionItem(SESSION_KEYS.documentName, entry.name);
      if (entry.qrContent) setSessionItem(SESSION_KEYS.qrContent, entry.qrContent);
      else removeSessionItem(SESSION_KEYS.qrContent);
      onResumePending();
      return;
    }
    setOpeningCode(entry.code);
    setRecentDownloadError(null);
    try {
      // Expired keys are already dropped when the list is read.
      let blob: Blob | null = null;
      try {
        blob = await loadSignedPdf(entry);
      } catch (err) {
        console.warn('[home] recent-signature fetch failed', err);
      }
      if (blob) {
        onRecentOpened(new File([blob], entry.name, { type: 'application/pdf' }), entry);
        return;
      }
      router.push(`/verify/?code=${encodeURIComponent(entry.code)}`);
    } finally {
      setOpeningCode(null);
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-white text-text-main">
      <Header />

      <main className="flex-1 bg-white">
        {/* Hero -> recent sessions -> upload card. The 4-step row that used
            to sit between them is gone (the wizard's header already shows
            the steps), and the bottom padding keeps the floating ScrollCue
            ("Xem các phương thức ký") clear of the upload card. */}
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-8 px-4 pb-16 pt-10 sm:px-6 sm:pt-14">
          <section className="w-full text-center">
            <h1 className="text-4xl font-semibold tracking-tight text-text-strong sm:text-5xl">
              {t('home.title')}
            </h1>

            {recentSignatures.length > 0 && (
              <div className="mt-7">
                <div className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {t('home.recentSignatures.title')}
                </div>
                {/* Phones: one swipeable row instead of 5 stacked chips
                    pushing the upload card down; wraps centred from sm up. */}
                <div className="-mx-4 mt-2.5 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0 sm:pb-0">
                  {recentSignatures.map((entry) => {
                    // A round still waiting for the signer: clock + "Đang chờ
                    // ký", no download (nothing signed yet). Click resumes it.
                    const pending = isPendingSignature(entry);
                    return (
                    <div
                      key={entry.code}
                      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-white py-1.5 pl-3.5 text-xs font-medium text-text-secondary shadow-sm ${
                        pending ? 'border-amber-200 pr-3.5' : 'border-border-subtle pr-1.5'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => void handleViewRecent(entry)}
                        disabled={openingCode !== null}
                        aria-busy={openingCode === entry.code}
                        title={pending ? `${entry.name} · ${t('home.recentSignatures.pending')}` : entry.name}
                        className="inline-flex items-center gap-1.5 text-primary-strong hover:underline disabled:cursor-wait"
                      >
                        {openingCode === entry.code ? (
                          <ButtonSpinner />
                        ) : (
                          <Icon
                            icon={pending ? 'lucide:clock' : 'lucide:history'}
                            className={`h-3.5 w-3.5 shrink-0 ${pending ? 'text-amber-600' : ''}`}
                          />
                        )}
                        <span className="max-w-[130px] truncate">{entry.name}</span>
                        {pending && (
                          <span className="shrink-0 whitespace-nowrap text-[11px] font-semibold text-amber-700">
                            {t('home.recentSignatures.pending')}
                          </span>
                        )}
                      </button>
                      {!pending && (
                      <button
                        type="button"
                        onClick={() => handleDownloadRecent(entry)}
                        disabled={downloadingCode === entry.code}
                        aria-label={t('home.recentSignatures.downloadButton')}
                        title={t('home.recentSignatures.downloadButton')}
                        className="rounded-full p-1 text-text-muted hover:bg-surface-soft hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {downloadingCode === entry.code ? (
                          <ButtonSpinner />
                        ) : (
                          <Icon icon="lucide:download" className="h-3.5 w-3.5" />
                        )}
                      </button>
                      )}
                    </div>
                    );
                  })}
                </div>
                {recentDownloadError && (
                  <p className="mt-1.5 text-[11px] text-error-text">{recentDownloadError}</p>
                )}
                {/* Where these live, for how long, and a way to wipe them
                    (shared computers) -- lib/browserHistory.ts. */}
                <div className="mt-2 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-[11px] text-text-muted">
                  {confirmingClear ? (
                    <>
                      <span>{t('home.recentSignatures.clearConfirm')}</span>
                      <button
                        type="button"
                        onClick={() => void handleClearHistory()}
                        className="font-semibold text-error-text hover:underline"
                      >
                        {t('home.recentSignatures.clearConfirmYes')}
                      </button>
                      <span aria-hidden="true">·</span>
                      <button
                        type="button"
                        onClick={() => setConfirmingClear(false)}
                        className="hover:text-text-main hover:underline"
                      >
                        {t('home.recentSignatures.clearConfirmNo')}
                      </button>
                    </>
                  ) : (
                    <>
                      <Icon icon="lucide:hard-drive" className="h-3 w-3" />
                      <span>{t('home.recentSignatures.storedNote')}</span>
                      <span aria-hidden="true">·</span>
                      <button
                        type="button"
                        onClick={() => setConfirmingClear(true)}
                        className="font-medium text-text-secondary hover:text-error-text hover:underline"
                      >
                        {t('home.recentSignatures.clearHistory')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </section>

          <div
            ref={signCardRef}
            className="w-full max-w-5xl"
          >
            <div className="flex items-center justify-center gap-3 px-4 pb-3">
              <div className="text-lg font-semibold text-text-strong">
                {t('home.signCard.title')}
              </div>
              <span className="shrink-0 whitespace-nowrap font-mono text-xs text-text-muted">
                {t('home.signCard.badge')}
              </span>
            </div>

            <div
              className={`flex min-h-[220px] flex-col items-center justify-center gap-2.5 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition ${
                validating
                  ? 'cursor-not-allowed border-border-subtle bg-surface-soft opacity-60'
                  : dragCounter > 0
                    ? 'border-primary bg-surface-soft ring-2 ring-primary/30'
                    : 'border-primary/60 bg-surface-soft'
              }`}
              onDragEnter={(e) => {
                e.preventDefault();
                if (validating) return;
                setDragCounter((prev) => prev + 1);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (validating) return;
                e.dataTransfer.dropEffect = 'copy';
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                if (validating) return;
                setDragCounter((prev) => Math.max(0, prev - 1));
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (validating) return;
                setDragCounter(0);
                handleFileSelected(e.dataTransfer.files?.[0] ?? null);
              }}
            >
              <span className="flex text-primary-strong">
                <Icon icon="lucide:file-check-2" className="h-8 w-8" />
              </span>
              <div className="text-xl font-semibold text-text-strong">
                {t('home.signCard.dropzoneTitle')}
              </div>
              <div className="max-w-[320px] text-sm text-text-secondary">
                {t('home.signCard.dropzoneSubtitle')}
              </div>

              <label htmlFor="home-file-input">
                <button
                  type="button"
                  disabled={validating}
                  onClick={() => document.getElementById('home-file-input')?.click()}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-2 text-sm font-semibold text-white shadow-sm shadow-primary/40 transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {validating && <ButtonSpinner />}
                  {validating ? t('common.uploading') : t('common.upload')}
                </button>
              </label>
              {/* suppressHydrationWarning: mobile browsers (e.g. Chrome iOS
                  autofill's `__gcruniqueid`) add attributes to form fields
                  before React hydrates -- not our bug. */}
              <input
                suppressHydrationWarning
                id="home-file-input"
                type="file"
                accept="application/pdf"
                disabled={validating}
                onChange={(e) => handleFileSelected(e.target.files?.[0] ?? null)}
                className="sr-only"
              />

              <div className="font-mono text-[11px] text-text-muted">
                {t('home.instruction2', {
                  maxSize: MAX_SIGN_UPLOAD_SIZE_MB,
                  formats: SUPPORTED_FILE_FORMATS.join(', '),
                })}
              </div>
              <p className="inline-flex items-center justify-center gap-1.5 text-center text-[12px] leading-snug text-text-secondary sm:whitespace-nowrap">
                <Icon icon="lucide:info" className="h-3.5 w-3.5 shrink-0" />
                <span>{t('home.supportedSignatures.sign.summary')}</span>
              </p>
            </div>

            {uploadError && (
              <div className="mx-2 mt-2 rounded-md border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text">
                {uploadError}
              </div>
            )}
          </div>
        </div>
      </main>

      <SigningMethodsSection />
      <ScrollCue targetId={SIGNING_METHODS_SECTION_ID} label={t('scrollCue.landing')} />
      <div className="bg-[#F5FBF7]">
        <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
          <CasIdVideoGuide className="" videoUrl={LANDING_GUIDE_VIDEO_EMBED_URL} />
        </div>
      </div>

      <Footer />
    </div>
  );
}
