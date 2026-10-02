'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import Header from './Header';
import Footer from './Footer';
import { SigningMethodsSection } from './home/SigningMethodsSection';
import { CassoBrandBand } from './home/CassoBrandBand';
import { ButtonSpinner, InlineSpinner } from './signing/Spinners';
import { MAX_SIGN_UPLOAD_SIZE_MB, MAX_UPLOAD_SIZE_MB } from './signing/constants';
import { Tabs, type TabItem } from './Tabs';
import { VerificationPopup } from './VerificationPopup';
import { SigningRoundResult } from './SigningRoundResult';
import { getRecentSignatures, type RecentSignature } from '@/lib/recentSignatures';
import { downloadSignedPdfBlob, signedFileName, triggerBlobDownload } from '@/lib/downloadSignedPdf';
import { lookupSigningRound } from '@/lib/signingRoundLookup';
import type { SigningRoundDetail } from '@/lib/cas/CasProvider';

const HOME_STEP_KEYS = ['upload', 'place', 'download'] as const;
const HOME_TAG_KEYS = ['invoices', 'reconciliation', 'hr'] as const;
const SUPPORTED_FILE_FORMATS = ['PDF'];

type Intent = 'sign' | 'verify';

type CodeLookupState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'result'; data: SigningRoundDetail };

/**
 * Ported from x-sign-web/src/features/home/HomePage.tsx. Adapted for the new
 * stateless architecture: the original called a separate `POST
 * /documents/upload` and navigated to `/request-signing/:documentId` on
 * success — there is no such separate upload step any more (upload +
 * placement + dispatch is a single request now), so a dropped/selected file
 * here is just validated locally and handed straight to the wizard view
 * (client-side, no network round-trip yet).
 *
 * Verification (by code or by uploading a signed PDF) now happens in a popup
 * right here instead of navigating to a separate `/verify` page (that page
 * and `/verify/[code]` were removed once this absorbed their job) — the
 * upload-tab state machine below is lifted from that old page almost
 * verbatim; only the code tab changed, from `router.push('/verify/'+code)`
 * to an in-place `lookupSigningRound` + `SigningRoundResult`, the same
 * pattern `SigningWizard.tsx`'s "Xem xác minh" popup already uses.
 */
export function HomeLanding({ onFileAccepted }: { onFileAccepted: (file: File) => void }) {
  const { t } = useTranslation();
  const [dragCounter, setDragCounter] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const signCardRef = useRef<HTMLDivElement>(null);

  const [intent, setIntent] = useState<Intent>('sign');
  const [codeInput, setCodeInput] = useState('');
  const [codeLookup, setCodeLookup] = useState<CodeLookupState | null>(null);

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

  // Signing is capped by CAS (10 MB); verifying allows the larger 20 MB.
  const maxUploadMb = intent === 'sign' ? MAX_SIGN_UPLOAD_SIZE_MB : MAX_UPLOAD_SIZE_MB;

  const handleFileSelected = (selected: File | null) => {
    if (!selected) return;
    const isPdfMime = selected.type === 'application/pdf';
    const isPdfExtension = selected.name.toLowerCase().endsWith('.pdf');
    if (!isPdfMime && !isPdfExtension) {
      setUploadError(t('upload.errorNotPdf'));
      return;
    }
    if (selected.size > maxUploadMb * 1024 * 1024) {
      setUploadError(t('upload.errorTooLarge', { maxMb: maxUploadMb }));
      return;
    }
    setUploadError(null);
    setValidating(true);
    onFileAccepted(selected);
  };

  // The top "Ký tài liệu"/"Xác minh chữ ký" pair no longer shows/hides
  // anything -- both the dropzone and the verify block below are always
  // visible -- so this only changes which one looks selected.
  const handleIntentChange = (next: Intent) => {
    setIntent(next);
  };

  const handleCodeSubmit = async (rawCode: string) => {
    const code = rawCode.trim();
    if (!code) return;
    setCodeLookup({ kind: 'loading' });
    const result = await lookupSigningRound(code);
    setCodeLookup(
      result.ok
        ? { kind: 'result', data: result.data }
        : { kind: 'error', message: result.message || t('signingRound.notFound') }
    );
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
    setIntent('verify');
    setCodeInput(entry.code);
    void handleCodeSubmit(entry.code);
  };

  const intentTabs: TabItem<Intent>[] = [
    { id: 'sign', label: t('home.intent.sign'), panelId: 'home-sign-panel' },
    { id: 'verify', label: t('home.intent.verify'), panelId: 'home-verify-panel' },
  ];

  return (
    <div className="flex min-h-screen flex-col bg-white text-text-main">
      <Header />

      <main className="flex-1 bg-[#F5FBF7]">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-6 sm:px-6 sm:py-8 lg:grid-cols-[1fr_560px] lg:items-start lg:gap-14">
          {/* Left: pitch + how it works */}
          <div>
            <div className="font-mono text-xs font-semibold uppercase tracking-widest text-primary-strong">
              {t('home.eyebrow')}
            </div>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text-strong sm:text-5xl">
              {t('home.title')}
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-text-secondary">
              {t('home.subtitle')}
            </p>

            <div className="mt-5 border-t border-border-subtle">
              {HOME_STEP_KEYS.map((key, index) => (
                <div key={key} className="flex gap-4 border-b border-border-subtle py-2.5">
                  <span className="pt-0.5 font-mono text-xs text-primary-strong">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-text-strong">
                      {t(`home.steps.${key}.title`)}
                    </div>
                    <div className="mt-1 text-[13.5px] text-text-secondary">
                      {t(`home.steps.${key}.description`)}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap gap-2.5">
              {HOME_TAG_KEYS.map((key) => (
                <span
                  key={key}
                  className="rounded-full border border-border-subtle bg-white px-3.5 py-1.5 text-xs font-medium text-text-secondary"
                >
                  {t(`home.tags.${key}`)}
                </span>
              ))}
            </div>

            {recentSignatures.length > 0 && (
              <div className="mt-6">
                <div className="text-xs font-semibold text-text-main">
                  {t('home.recentSignatures.title')}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
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
          </div>

          {/* Right: sign-now card + (when verifying) the verify block right
              below it -- both wrapped together so they occupy this one grid
              cell instead of the verify block becoming a 3rd, misplaced
              grid item of its own. */}
          <div>
          <div
            ref={signCardRef}
            className="rounded-3xl border border-border-subtle bg-white p-3 shadow-md"
          >
            <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-3.5">
              <div className="text-lg font-semibold text-text-strong">
                {t('home.signCard.title')}
              </div>
              <span className="shrink-0 whitespace-nowrap font-mono text-xs text-text-muted">
                {t('home.signCard.badge')}
              </span>
            </div>

            <div className="px-4 pb-3">
              <Tabs
                tabs={intentTabs}
                value={intent}
                onChange={handleIntentChange}
                idPrefix="home-intent"
                ariaLabel={t('home.intent.ariaLabel')}
              />
            </div>

            <div
              className={`flex min-h-[260px] flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed p-8 text-center transition ${
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
                <Icon icon="lucide:file-check-2" className="h-14 w-14" />
              </span>
              <div className="text-2xl font-semibold text-text-strong">
                {t('home.signCard.dropzoneTitle')}
              </div>
              <div className="max-w-[320px] text-base text-text-secondary">
                {t('home.signCard.dropzoneSubtitle')}
              </div>

              <label htmlFor="home-file-input" className="mt-1">
                <button
                  type="button"
                  disabled={validating}
                  onClick={() => document.getElementById('home-file-input')?.click()}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-7 py-3 text-base font-semibold text-white shadow-sm shadow-primary/40 transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {validating && <ButtonSpinner />}
                  {validating ? t('common.uploading') : t('common.upload')}
                </button>
              </label>
              <input
                id="home-file-input"
                type="file"
                accept="application/pdf"
                disabled={validating}
                onChange={(e) => handleFileSelected(e.target.files?.[0] ?? null)}
                className="sr-only"
              />

              <div className="font-mono text-[11px] text-text-muted">
                {t('home.instruction2', {
                  maxSize: maxUploadMb,
                  formats: SUPPORTED_FILE_FORMATS.join(', '),
                })}
              </div>
              {/* What this tab can handle -- signing only goes through Cas ID,
                  verification accepts any device (USB token, HSM, SIM PKI). */}
              <p className="-mt-2 inline-flex items-start gap-1.5 text-left text-[12px] leading-snug text-text-secondary sm:whitespace-nowrap">
                <Icon icon="lucide:info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{t(`home.supportedSignatures.${intent}.summary`)}</span>
              </p>
            </div>

            {uploadError && (
              <div className="mx-2 mt-2 rounded-md border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text">
                {uploadError}
              </div>
            )}
          </div>

          {/* Verify UI lives right below the sign card itself, always
              visible by default (not gated behind picking "Xác minh chữ ký"
              above -- that top pair is just a visual label pointing at
              which section is which, not a show/hide switch). */}
          <div className="mt-4 rounded-3xl border border-border-subtle bg-white p-5 shadow-md">
              <div className="mb-3 text-base font-semibold text-text-strong">
                {t('verify.title')}
              </div>
              <form
                className="flex flex-col gap-3 sm:flex-row sm:items-center"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleCodeSubmit(codeInput);
                }}
              >
                <label className="sr-only" htmlFor="home-verify-code-input">
                  {t('verify.form.codeLabel')}
                </label>
                <input
                  id="home-verify-code-input"
                  type="text"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  placeholder={t('verify.form.codePlaceholder')}
                  className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary sm:max-w-sm"
                />
                <button
                  type="submit"
                  disabled={!codeInput.trim()}
                  className="inline-flex items-center justify-center rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t('verify.form.verify')}
                </button>
              </form>
              <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-text-soft">
                <Icon icon="lucide:info" className="h-3.5 w-3.5 shrink-0" />
                <span>{t('verify.form.codeFormatHint')}</span>
              </p>
            </div>
          </div>
        </div>
      </main>

      <SigningMethodsSection />
      <CassoBrandBand />

      {/* The lookup FORM stays inline (always visible, see the comment
          above) -- but its RESULT (loading/error/result) opens in a popup,
          same as clicking a "5 phiên ký gần nhất" tag below. */}
      {codeLookup && (
        <VerificationPopup onClose={() => setCodeLookup(null)}>
          {codeLookup.kind === 'loading' && (
            <div className="flex flex-col items-center justify-center py-10 text-center text-sm text-text-muted">
              <InlineSpinner />
              <p className="mt-2">{t('verify.loadingResult')}</p>
            </div>
          )}
          {codeLookup.kind === 'error' && (
            <div className="px-2 py-6 text-center text-sm text-error-text">
              {codeLookup.message}
            </div>
          )}
          {codeLookup.kind === 'result' && <SigningRoundResult data={codeLookup.data} />}
        </VerificationPopup>
      )}

      <Footer />
    </div>
  );
}
