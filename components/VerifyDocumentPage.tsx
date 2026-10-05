'use client';

import '@/lib/i18n/init';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { Icon } from '@iconify/react';
import Header from './Header';
import Footer from './Footer';
import { ButtonSpinner, InlineSpinner } from './signing/Spinners';
import { MAX_UPLOAD_SIZE_MB } from './signing/constants';
import { VerificationPopup } from './VerificationPopup';
import { VerificationResultPanel } from './VerificationResultPanel';
import { SigningRoundResult } from './SigningRoundResult';
import { lookupSigningRound } from '@/lib/signingRoundLookup';
import type { SigningRoundDetail } from '@/lib/cas/CasProvider';
import type { VerificationResult } from '@/lib/verification/verifyPdfSignatures';

const EXPLAIN_STEPS = ['read', 'signature', 'content', 'chain', 'root', 'time'] as const;

type CodeLookupState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'result'; data: SigningRoundDetail };

type UploadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'result'; signatures: VerificationResult[] };

export function VerifyDocumentPage() {
  const { t } = useTranslation();
  const searchParams = useSearchParams();
  const [codeInput, setCodeInput] = useState('');
  const [codeLookup, setCodeLookup] = useState<CodeLookupState | null>(null);
  const [dragCounter, setDragCounter] = useState(0);
  const [upload, setUpload] = useState<UploadState>({ kind: 'idle' });
  const autoRan = useRef(false);

  const submitCode = useCallback(
    async (rawCode: string) => {
      const code = rawCode.trim();
      if (!code) return;
      setCodeLookup({ kind: 'loading' });
      const result = await lookupSigningRound(code);
      setCodeLookup(
        result.ok
          ? { kind: 'result', data: result.data }
          : { kind: 'error', message: result.message || t('signingRound.notFound') }
      );
    },
    [t]
  );

  useEffect(() => {
    const code = searchParams.get('code')?.trim() ?? '';
    if (!code || autoRan.current) return;
    autoRan.current = true;
    // The code arrives from the URL after mount. Reading it during render
    // would mismatch hydration when the server has no query string.
     
    setCodeInput(code);
    void submitCode(code);
  }, [searchParams, submitCode]);

  const verifyFile = async (selected: File | null) => {
    if (!selected) return;
    const isPdfMime = selected.type === 'application/pdf';
    const isPdfExtension = selected.name.toLowerCase().endsWith('.pdf');
    if (!isPdfMime && !isPdfExtension) {
      setUpload({ kind: 'error', message: t('verifyUpload.error.notPdf') });
      return;
    }
    if (selected.size > MAX_UPLOAD_SIZE_MB * 1024 * 1024) {
      setUpload({
        kind: 'error',
        message: t('verifyUpload.error.tooLarge', { maxMb: MAX_UPLOAD_SIZE_MB }),
      });
      return;
    }

    setUpload({ kind: 'loading' });
    try {
      const form = new FormData();
      form.append('file', selected);
      const res = await fetch('/api/verify/upload', { method: 'POST', body: form });
      const body = (await res.json().catch(() => null)) as { signatures?: VerificationResult[] } | null;
      if (!res.ok) {
        setUpload({ kind: 'error', message: t('verifyUpload.genericError') });
        return;
      }
      const signatures = Array.isArray(body?.signatures) ? body.signatures : [];
      setUpload(signatures.length > 0 ? { kind: 'result', signatures } : { kind: 'empty' });
    } catch (error) {
      console.warn('[verify] upload verification failed', error);
      setUpload({ kind: 'error', message: t('verifyUpload.genericError') });
    }
  };

  const verifying = upload.kind === 'loading';

  return (
    <div className="flex min-h-screen flex-col bg-white text-text-main">
      <Header />
      <main className="flex-1 bg-[#F5FBF7]">
        <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
          <div className="font-mono text-xs font-semibold uppercase tracking-widest text-primary-strong">
            {t('nav.verifyKicker')}
          </div>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-text-strong sm:text-5xl">
            {t('verifyPage.title')}
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-relaxed text-text-secondary">
            {t('verifyPage.lead')}
          </p>

          <div className="mt-8 grid items-start gap-4 lg:grid-cols-2">
            <section className="rounded-3xl border border-border-subtle bg-white p-5 shadow-md">
              <div className="font-mono text-xs font-semibold uppercase tracking-widest text-primary-strong">
                {t('verifyPage.session.kicker')}
              </div>
              <h2 className="mt-2 text-lg font-semibold text-text-strong">{t('verify.title')}</h2>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                {t('verifyPage.session.description')}
              </p>
              {/* suppressHydrationWarning on this page's form fields: mobile
                  browsers (e.g. Chrome iOS autofill's `__gcruniqueid`) add
                  attributes to them before React hydrates -- not our bug. */}
              <form
                suppressHydrationWarning
                className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitCode(codeInput);
                }}
              >
                <label className="sr-only" htmlFor="verify-code-input">
                  {t('verify.form.codeLabel')}
                </label>
                <input
                  suppressHydrationWarning
                  id="verify-code-input"
                  type="text"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  placeholder={t('verify.form.codePlaceholder')}
                  className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary"
                />
                <button
                  type="submit"
                  disabled={!codeInput.trim()}
                  className="inline-flex shrink-0 items-center justify-center rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {t('verify.form.verify')}
                </button>
              </form>
              <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-text-soft">
                <Icon icon="lucide:info" className="h-3.5 w-3.5 shrink-0" />
                <span>{t('verify.form.codeFormatHint')}</span>
              </p>
            </section>

            <section className="rounded-3xl border border-border-subtle bg-white p-5 shadow-md">
              <div className="font-mono text-xs font-semibold uppercase tracking-widest text-primary-strong">
                {t('verifyPage.chain.kicker')}
              </div>
              <h2 className="mt-2 text-lg font-semibold text-text-strong">{t('verifyPage.chain.title')}</h2>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                {t('verifyPage.chain.description')}
              </p>
              <div
                className={`mt-4 flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed p-6 text-center transition ${
                  verifying
                    ? 'cursor-not-allowed border-border-subtle bg-surface-soft opacity-60'
                    : dragCounter > 0
                      ? 'border-primary bg-surface-soft ring-2 ring-primary/30'
                      : 'border-primary/60 bg-surface-soft'
                }`}
                onDragEnter={(e) => {
                  e.preventDefault();
                  if (verifying) return;
                  setDragCounter((prev) => prev + 1);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (verifying) return;
                  e.dataTransfer.dropEffect = 'copy';
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  if (verifying) return;
                  setDragCounter((prev) => Math.max(0, prev - 1));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (verifying) return;
                  setDragCounter(0);
                  void verifyFile(e.dataTransfer.files?.[0] ?? null);
                }}
              >
                {verifying ? (
                  <InlineSpinner />
                ) : (
                  <Icon icon="lucide:file-check-2" className="h-10 w-10 text-primary-strong" />
                )}
                <div className="text-lg font-semibold text-text-strong">
                  {verifying ? t('verify.loadingResult') : t('verifyPage.chain.dropzoneTitle')}
                </div>
                {!verifying && (
                  <div className="max-w-[320px] text-sm text-text-secondary">
                    {t('verifyPage.chain.dropzoneSubtitle')}
                  </div>
                )}
                <label htmlFor="verify-file-input">
                  <button
                    type="button"
                    disabled={verifying}
                    onClick={() => document.getElementById('verify-file-input')?.click()}
                    className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-sm font-semibold text-white shadow-sm shadow-primary/40 transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {verifying && <ButtonSpinner />}
                    {t('verifyUpload.form.button')}
                  </button>
                </label>
                <input
                  suppressHydrationWarning
                  id="verify-file-input"
                  type="file"
                  accept="application/pdf"
                  disabled={verifying}
                  onChange={(e) => {
                    void verifyFile(e.target.files?.[0] ?? null);
                    e.target.value = '';
                  }}
                  className="sr-only"
                />
                <p className="flex items-start gap-1.5 text-left text-[12px] leading-snug text-text-secondary">
                  <Icon icon="lucide:info" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t('home.supportedSignatures.verify.summary')}</span>
                </p>
              </div>
              {upload.kind === 'error' && (
                <div className="mt-3 rounded-md border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text">
                  {upload.message}
                </div>
              )}
              {upload.kind === 'empty' && (
                <p className="mt-3 text-sm text-text-secondary">{t('verifyUpload.noSignatureFound')}</p>
              )}
            </section>
          </div>

          {upload.kind === 'result' && (
            <div className="mt-6 space-y-4">
              {upload.signatures.map((signature, index) => (
                <VerificationResultPanel
                  key={`${signature.position ?? index}-${signature.certificate?.serialNumber ?? index}`}
                  result={signature}
                />
              ))}
            </div>
          )}
        </div>

        <section className="bg-white" aria-labelledby="verify-explain-title">
          <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16">
            <div className="font-mono text-xs font-semibold uppercase tracking-widest text-primary-strong">
              {t('verifyPage.explain.eyebrow')}
            </div>
            <h2
              id="verify-explain-title"
              className="mt-3 max-w-3xl text-2xl font-semibold tracking-tight text-text-strong sm:text-3xl"
            >
              {t('verifyPage.explain.title')}
            </h2>
            <p className="mt-4 max-w-3xl text-base leading-relaxed text-text-secondary">
              {t('verifyPage.explain.intro')}
            </p>
            <ol className="mt-6 max-w-3xl border-t border-border-subtle">
              {EXPLAIN_STEPS.map((key, index) => (
                <li key={key} className="flex gap-4 border-b border-border-subtle py-3.5">
                  <span className="pt-0.5 font-mono text-xs text-primary-strong">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-text-strong">
                      {t(`verifyPage.explain.steps.${key}.title`)}
                    </div>
                    <p className="mt-1 text-[13.5px] leading-relaxed text-text-secondary">
                      {t(`verifyPage.explain.steps.${key}.description`)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-5 max-w-3xl text-sm leading-relaxed text-text-secondary">
              {t('verifyPage.explain.note')}
            </p>
          </div>
        </section>
      </main>

      {codeLookup && (
        <VerificationPopup onClose={() => setCodeLookup(null)}>
          {codeLookup.kind === 'loading' && (
            <div className="flex flex-col items-center justify-center py-10 text-center text-sm text-text-muted">
              <InlineSpinner />
              <p className="mt-2">{t('verify.loadingResult')}</p>
            </div>
          )}
          {codeLookup.kind === 'error' && (
            <div className="px-2 py-6 text-center text-sm text-error-text">{codeLookup.message}</div>
          )}
          {codeLookup.kind === 'result' && <SigningRoundResult data={codeLookup.data} />}
        </VerificationPopup>
      )}

      <Footer />
    </div>
  );
}
