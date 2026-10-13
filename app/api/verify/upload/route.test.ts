import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DetailedVerificationResult } from '@/lib/verification/verifyPdfSignatures';

/**
 * The technical reason behind a non-valid verdict (`detail`, e.g. why an
 * intermediate-certificate download failed) is for the SERVER LOG only --
 * this pins that it never reaches the response the browser gets.
 */

const AIA_URL = 'http://ca.example.test/sub.crt';
const AIA_ERROR = `${AIA_URL}: Guarded fetch to ca.example.test timed out (1 attempt)`;

const detailed: DetailedVerificationResult[] = [
  {
    result: {
      status: 'ROOT_NOT_TRUSTED',
      message: 'The signature and content are cryptographically valid, but the root CA is not in the trust store.',
      position: 1,
      contentIntact: true,
      certificateChainRootNotInTrustStore: true,
    },
    detail: { reason: 'ROOT_NOT_IN_TRUST_STORE', rootIssuer: 'CN=Test Sub CA', aiaError: AIA_ERROR },
  },
];

vi.mock('@/lib/verification/verifyPdfSignatures', () => ({
  verifyPdfSignaturesDetailed: async () => detailed,
}));

const { POST } = await import('./route');

function upload(): Request {
  const form = new FormData();
  form.append('file', new File([Buffer.from('%PDF-1.4\n%%EOF\n')], 'signed.pdf', { type: 'application/pdf' }));
  return new Request('http://127.0.0.1:3000/api/verify/upload', {
    method: 'POST',
    body: form,
    headers: { 'x-forwarded-for': '10.9.9.9' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/verify/upload -- AIA failure reason stays server-side', () => {
  it('logs aiaError on the server but never returns it to the browser', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await POST(upload());
    expect(res.status).toBe(200);
    const text = await res.text();

    // Response: the verdict only -- no technical detail, no AIA URL.
    expect(text).not.toContain('aiaError');
    expect(text).not.toContain('aiaFailures');
    expect(text).not.toContain(AIA_URL);
    expect(JSON.parse(text).signatures[0]).toEqual(detailed[0]!.result);

    // Server log: carries the real reason for the developer.
    const logged = warn.mock.calls.find(([line]) => String(line).startsWith('[verify:upload] signature #1'));
    expect(logged?.[1]).toMatchObject({ reason: 'ROOT_NOT_IN_TRUST_STORE', aiaError: AIA_ERROR });
  });
});
