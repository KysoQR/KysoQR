import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SigningRoundDetail } from '@/lib/cas/CasProvider';

/**
 * MEDIUM-05: the lookup code is printed on every signed PDF, so this endpoint
 * is public. It must never hand out the signer's full citizen ID or CAS's raw
 * device record, and it must not let anyone guess codes cheaply.
 */

const NOT_FOUND = new Error('not found');

const casRound = {
  device: { model: 'iPhone12,1', imei: '356938035643809', os: 'iOS 18', ip: '203.0.113.7' },
  signer: { displayName: 'NGUYỄN VĂN A', email: 'a@example.test' },
  authMethod: 'Cas ID',
  signedAt: '2026-09-29T03:15:42.000Z',
  phone: '0900000000',
  certificate: {
    issuer: { commonName: 'CA Example', organization: 'Example CA', country: 'VN' },
    signer: { commonName: 'NGUYỄN VĂN A', country: 'VN', taxOrCitizenId: 'CCCD:001099012345' },
    documentIntegrity: 'Không bị thay đổi',
    validFrom: '2026-01-01T00:00:00.000Z',
    validTo: '2027-01-01T00:00:00.000Z',
    signatureValidity: 'Hợp lệ tại thời điểm ký',
    hasTimestamp: 'Có',
    signedAtLong: '10:15:42 29/09/2026',
  },
} as unknown as SigningRoundDetail;

const getSigningRound = vi.fn(async (code: string) => {
  if (code === 'kysoqr.com#missing') throw NOT_FOUND;
  return { signingRound: casRound };
});

vi.mock('@/lib/cas/getCasProvider', () => ({
  getCasProvider: () => ({
    getSigningRound,
    isSigningRoundNotFoundError: (error: unknown) => error === NOT_FOUND,
    isRateLimitedError: () => false,
  }),
}));

const { GET } = await import('./route');

let ipCounter = 0;
async function lookup(code: string, ip = `10.1.0.${++ipCounter % 250}`) {
  const request = new Request(`http://127.0.0.1:3000/api/verify/signing-round/x`, {
    headers: { 'x-forwarded-for': ip },
  });
  const response = await GET(request, { params: Promise.resolve({ orgIdSigned: code }) });
  return { response, body: await response.json() };
}

beforeEach(() => {
  getSigningRound.mockClear();
});

describe('GET /api/verify/signing-round/[orgIdSigned]', () => {
  it('masks the citizen ID and keeps only allow-listed fields', async () => {
    const { response, body } = await lookup('kysoqr.com#3bLzsA');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(getSigningRound).toHaveBeenCalledWith('kysoqr.com#3bLzsA');
    expect(body.signingRound.certificate.signer.taxOrCitizenId).toBe('CCCD:********2345');
    expect(body.signingRound.device).toEqual({ model: 'iPhone12,1' });
    expect(body.signingRound.signer).toEqual({ displayName: 'NGUYỄN VĂN A' });
    expect(body.signingRound.certificate.issuer).toEqual({
      commonName: 'CA Example',
      organization: 'Example CA',
      country: 'VN',
    });
    const text = JSON.stringify(body);
    for (const leaked of [
      '001099012345',
      '356938035643809',
      '203.0.113.7',
      'a@example.test',
      '0900000000',
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  it('accepts a code that still arrives percent-encoded', async () => {
    await lookup('kysoqr.com%233bLzsA');
    expect(getSigningRound).toHaveBeenCalledWith('kysoqr.com#3bLzsA');
  });

  it('answers null without asking CAS for a bare or malformed code', async () => {
    for (const code of ['3bLzsA', 'XXXXXX', 'kysoqr.com#abc', 'kysoqr.com#3bLz$A', '#3bLzsA']) {
      const { response, body } = await lookup(code);
      expect(response.status).toBe(200);
      expect(body).toEqual({ signingRound: null });
    }
    expect(getSigningRound).not.toHaveBeenCalled();
  });

  it('answers null for a code CAS does not know', async () => {
    const { body } = await lookup('kysoqr.com#missing');
    expect(body).toEqual({ signingRound: null });
  });

  it('allows 10 lookups a minute per IP, then 429', async () => {
    const ip = '10.2.0.1';
    for (let i = 0; i < 10; i += 1) {
      expect((await lookup('kysoqr.com#3bLzsA', ip)).response.status).toBe(200);
    }
    const { response } = await lookup('kysoqr.com#3bLzsA', ip);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBeTruthy();
  });
});
