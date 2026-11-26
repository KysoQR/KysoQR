import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubmitDocumentInput } from '@/lib/cas/CasProvider';

/**
 * `signType` (PERSONAL / BUSINESS / omitted) replaced `signerType`: what the
 * route accepts, and what it forwards to CAS.
 */

const submitDocument = vi.fn(async (input: SubmitDocumentInput) => ({
  signRequestId: input.signRequestId,
  signToken: 't',
  qrContent: 'https://example.test/qr',
  state: 'NEW',
}));

vi.mock('@/lib/cas/getCasProvider', () => ({
  getCasProvider: () => ({
    submitDocument,
    isPersonNotFoundError: () => false,
    isRateLimitedError: () => false,
    isCertificateNotFoundError: () => false,
  }),
}));

const { POST } = await import('./route');

const PDF = new File([new TextEncoder().encode('%PDF-1.4\n%%EOF\n')], 'hop-dong.pdf', {
  type: 'application/pdf',
});
const FIELDS = JSON.stringify([{ page: 1, xRatio: 0.5, yRatio: 0.7, widthRatio: 0.3, heightRatio: 0.1 }]);

let ipCounter = 0;
async function post(fields: Record<string, string>) {
  const form = new FormData();
  form.append('file', PDF);
  form.append('signatureFields', FIELDS);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const request = new Request('http://127.0.0.1:3000/api/sign/request', {
    method: 'POST',
    body: form,
    headers: { 'x-forwarded-for': `10.2.0.${++ipCounter % 250}` },
  });
  const response = await POST(request);
  return { response, body: await response.json() };
}
const sent = () => submitDocument.mock.calls.at(-1)?.[0];

beforeEach(() => {
  submitDocument.mockClear();
});

describe('POST /api/sign/request -- signType', () => {
  it('omitted: no signType and no tax code sent to CAS (the signer chooses)', async () => {
    const { response } = await post({ taxCode: '0101010101' });
    expect(response.status).toBe(200);
    expect(sent()?.signType).toBeNull();
    expect(sent()?.taxCode).toBeNull();
  });

  it('PERSONAL: forwarded, a tax code is ignored', async () => {
    const { response } = await post({ signType: 'PERSONAL', taxCode: '0101010101' });
    expect(response.status).toBe(200);
    expect(sent()?.signType).toBe('PERSONAL');
    expect(sent()?.taxCode).toBeNull();
  });

  it('BUSINESS without a tax code: forwarded, no tax code (any business certificate)', async () => {
    const { response } = await post({ signType: 'BUSINESS' });
    expect(response.status).toBe(200);
    expect(sent()?.signType).toBe('BUSINESS');
    expect(sent()?.taxCode).toBeNull();
  });

  it('BUSINESS with a tax code: both forwarded', async () => {
    const { response } = await post({ signType: 'BUSINESS', taxCode: '0101010101-001' });
    expect(response.status).toBe(200);
    expect(sent()?.signType).toBe('BUSINESS');
    expect(sent()?.taxCode).toBe('0101010101-001');
  });

  it('an unknown signType is a 400, CAS is never called', async () => {
    const { response, body } = await post({ signType: 'individual' });
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: 'INVALID_SIGNER_CONFIG', message: 'signType must be "PERSONAL" or "BUSINESS"' });
    expect(submitDocument).not.toHaveBeenCalled();
  });

  it('the old signerType field is rejected with a pointer to signType', async () => {
    const { response, body } = await post({ signerType: 'individual' });
    expect(response.status).toBe(400);
    expect(body.error).toBe('INVALID_SIGNER_CONFIG');
    expect(body.message).toContain('signType');
    expect(submitDocument).not.toHaveBeenCalled();
  });

  it('BUSINESS with a malformed tax code is a 400', async () => {
    const { response, body } = await post({ signType: 'BUSINESS', taxCode: '123' });
    expect(response.status).toBe(400);
    expect(body.message).toMatch(/taxCode must be 10 digits/);
    expect(submitDocument).not.toHaveBeenCalled();
  });
});
