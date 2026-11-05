import { describe, expect, it, vi } from 'vitest';

/**
 * Next.js loads these modules once per route bundle and once more for
 * instrumentation.ts, and the VNeID deps on globalThis (CSign client, PDF
 * worker runner, TSA) come from whichever copy created them first. An error
 * they throw must still be recognized by the route's own copy, or every CSign
 * refusal turns into VNEID_INTERNAL. Two copies are loaded here the same way.
 */
async function loadCopy() {
  return {
    CsignError: (await import('./csignClient')).CsignError,
    VneidError: (await import('./errors')).VneidError,
    TsaError: (await import('./tsa')).TsaError,
    PdfSignError: (await import('../pdfSign/errors')).PdfSignError,
  };
}

describe('errors from another copy of a module', () => {
  it('are recognized by instanceof, and nothing else is', async () => {
    const first = await loadCopy();
    vi.resetModules();
    const second = await loadCopy();
    expect(second.CsignError).not.toBe(first.CsignError);

    expect(new first.CsignError('NO_CERTIFICATE', '/x', 'm') instanceof second.CsignError).toBe(
      true
    );
    expect(new first.VneidError('VNEID_UPSTREAM', 'm') instanceof second.VneidError).toBe(true);
    expect(new first.TsaError('m') instanceof second.TsaError).toBe(true);
    expect(new first.PdfSignError('PDF_LOCKED', 'm') instanceof second.PdfSignError).toBe(true);

    expect(new Error('m') instanceof second.CsignError).toBe(false);
    expect(new first.VneidError('VNEID_UPSTREAM', 'm') instanceof second.CsignError).toBe(false);
    expect(new first.TsaError('m') instanceof second.PdfSignError).toBe(false);
    // The brand stays out of logs and JSON.
    expect(JSON.stringify(new first.TsaError('m'))).toBe('{"name":"TsaError"}');
  });
});
