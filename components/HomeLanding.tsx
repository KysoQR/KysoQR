'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import Header from './Header';
import Footer from './Footer';
import { SIGNING_METHODS_SECTION_ID, SigningMethodsSection } from './home/SigningMethodsSection';
import { ScrollCue } from './ScrollCue';
import { CassoBrandBand } from './home/CassoBrandBand';
import { ButtonSpinner } from './signing/Spinners';
import { MAX_SIGN_UPLOAD_SIZE_MB } from './signing/constants';
import { getRecentSignatures, type RecentSignature } from '@/lib/recentSignatures';
import { downloadSignedPdfBlob, signedFileName, triggerBlobDownload } from '@/lib/downloadSignedPdf';

const HOME_STEP_KEYS = ['upload', 'place', 'sign', 'download'] as const;
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
 * on `/verify`. A recent-signature chip here only navigates there.
 */
export function HomeLanding({ onFileAccepted }: { onFileAccepted: (file: File) => void }) {
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
  }, []);
  const [recentDownloadError, setRecentDownloadError] = useState<string | null>(null);
  const [downloadingCode, setDownloadingCode] = useState<string | null>(null);

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

  const handleDownloadRecent = async (entry: RecentSignature) => {
    if (!entry.identityKey) {
      setRecentDownloadError(t('home.recentSignatures.downloadError'));
      return;
    }
    setDownloadingCode(entry.code);
    setRecentDownloadError(null);
    try {
      const blob = await downloadSignedPdfBlob(entry.identityKey);
      triggerBlobDownload(blob, signedFileName(entry.name));
    } catch (err) {
      console.warn('[home] recent-signature download failed', err);
      setRecentDownloadError(t('home.recentSignatures.downloadError'));
    } finally {
      setDownloadingCode(null);
    }
  };

  const handleViewRecent = (entry: RecentSignature) => {
    router.push(`/verify/?code=${encodeURIComponent(entry.code)}`);
  };

  return (
    <div className="flex min-h-screen flex-col bg-white text-text-main">
      <Header />

      <main className="flex-1 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center gap-10 px-4 py-8 sm:px-6 sm:py-10">
          <section className="w-full max-w-3xl text-center">
            <h1 className="text-4xl font-semibold tracking-tight text-text-strong sm:text-5xl">
              {t('home.title')}
            </h1>

            {recentSignatures.length > 0 && (
              <div className="mt-6">
                <div className="text-xs font-semibold text-text-main">
                  {t('home.recentSignatures.title')}
                </div>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  {recentSignatures.map((entry) => (
                    <div
                      key={entry.code}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-white py-1.5 pl-3.5 pr-1.5 text-xs font-medium text-text-secondary shadow-sm"
                    >
                      <button
                        type="button"
                        onClick={() => handleViewRecent(entry)}
                        title={entry.name}
                        className="inline-flex max-w-[160px] items-center gap-1.5 truncate text-primary-strong hover:underline"
                      >
                        <Icon icon="lucide:history" className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{entry.name}</span>
                      </button>
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
                    </div>
                  ))}
                </div>
                {recentDownloadError && (
                  <p className="mt-1.5 text-[11px] text-error-text">{recentDownloadError}</p>
                )}
              </div>
            )}
          </section>

          <ol className="relative hidden w-full gap-6 text-center lg:grid lg:grid-cols-4">
            <span
              aria-hidden="true"
              className="absolute left-[12.5%] right-[12.5%] top-[13px] hidden h-px bg-border-subtle lg:block"
            />
            {HOME_STEP_KEYS.map((key, index) => (
              <li key={key} className="flex flex-col items-center">
                <div className="relative z-10 flex h-7 w-7 items-center justify-center rounded-full bg-white font-mono text-xs text-primary-strong ring-1 ring-primary/40">
                  {String(index + 1).padStart(2, '0')}
                </div>
                <div className="mt-3 text-sm font-semibold text-text-strong">
                  {t(`home.steps.${key}.title`)}
                </div>
              </li>
            ))}
          </ol>

          <div
            ref={signCardRef}
            className="w-full"
          >
            <div className="flex items-center justify-center gap-3 px-4 pb-3 pt-3.5">
              <div className="text-lg font-semibold text-text-strong">
                {t('home.signCard.title')}
              </div>
              <span className="shrink-0 whitespace-nowrap font-mono text-xs text-text-muted">
                {t('home.signCard.badge')}
              </span>
            </div>

            <div
              className={`flex min-h-[156px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-5 text-center transition ${
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
      <CassoBrandBand />

      <Footer />
    </div>
  );
}
