import { afterEach, describe, expect, it, vi } from 'vitest';
import { VneidError } from './errors';
import {
  bearerSecret,
  checkOrigin,
  declaredLength,
  languageOf,
  PER_IP_PER_SECOND,
  perSecondLimit,
  readBody,
  SERVICE_PER_SECOND,
} from './http';
import { verifyTurnstile } from './turnstile';

const request = (headers: Record<string, string>, body?: string) =>
  new Request('http://localhost:3000/api/vneid/sign', { method: 'POST', headers, body });

const codeOf = async (run: () => unknown) => {
  try {
    await run();
  } catch (error) {
    if (error instanceof VneidError) return error.code;
    throw error;
  }
  return undefined;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('checkOrigin', () => {
  it('compares with APP_ORIGIN when it is set', async () => {
    vi.stubEnv('APP_ORIGIN', 'https://kysoqr.example/');
    expect(
      await codeOf(() => checkOrigin(request({ origin: 'https://kysoqr.example' })))
    ).toBeUndefined();
    expect(await codeOf(() => checkOrigin(request({ origin: 'https://evil.example' })))).toBe(
      'VNEID_FORBIDDEN_ORIGIN'
    );
  });

  it('falls back to the Host the request was sent to (local development)', async () => {
    vi.stubEnv('APP_ORIGIN', '');
    expect(
      await codeOf(() =>
        checkOrigin(request({ origin: 'http://localhost:3000', host: 'localhost:3000' }))
      )
    ).toBeUndefined();
    expect(
      await codeOf(() =>
        checkOrigin(request({ origin: 'http://evil.example', host: 'localhost:3000' }))
      )
    ).toBe('VNEID_FORBIDDEN_ORIGIN');
    expect(await codeOf(() => checkOrigin(request({ host: 'localhost:3000' })))).toBe(
      'VNEID_FORBIDDEN_ORIGIN'
    );
    expect(
      await codeOf(() => checkOrigin(request({ origin: 'null', host: 'localhost:3000' })))
    ).toBe('VNEID_FORBIDDEN_ORIGIN');
  });
});

describe('request helpers', () => {
  it('requires and caps Content-Length', async () => {
    expect(declaredLength(request({ 'content-length': '10' }), 100)).toBe(10);
    expect(await codeOf(() => declaredLength(request({}), 100))).toBe('VNEID_LENGTH_REQUIRED');
    expect(await codeOf(() => declaredLength(request({ 'content-length': '-1' }), 100))).toBe(
      'VNEID_LENGTH_REQUIRED'
    );
    expect(await codeOf(() => declaredLength(request({ 'content-length': '101' }), 100))).toBe(
      'VNEID_PAYLOAD_TOO_LARGE'
    );
  });

  it('never reads past the cap', async () => {
    expect((await readBody(request({}, 'hello'), 10)).toString()).toBe('hello');
    expect(await codeOf(() => readBody(request({}, 'x'.repeat(11)), 10))).toBe(
      'VNEID_PAYLOAD_TOO_LARGE'
    );
  });

  it('reads the bearer secret and the language', () => {
    expect(bearerSecret(request({ authorization: 'Bearer abc_DEF-1' }))).toBe('abc_DEF-1');
    expect(bearerSecret(request({ authorization: 'Basic abc' }))).toBe('');
    expect(languageOf(request({ 'accept-language': 'en-US,en;q=0.9' }))).toBe('en');
    expect(languageOf(request({ 'accept-language': 'vi-VN' }))).toBe('vi');
    expect(languageOf(request({ 'accept-language': 'en' }), 'vi')).toBe('vi');
  });
});

describe('verifyTurnstile', () => {
  const answer = (body: object) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));

  it('is off without TURNSTILE_SECRET', async () => {
    vi.stubEnv('TURNSTILE_SECRET', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await verifyTurnstile(request({}), '203.0.113.1');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails closed once enabled', async () => {
    vi.stubEnv('TURNSTILE_SECRET', 'turnstile-secret');
    vi.stubEnv('APP_ORIGIN', 'https://kysoqr.example');
    expect(await codeOf(() => verifyTurnstile(request({}), 'x'))).toBe('VNEID_CHALLENGE_FAILED');

    const withToken = request({ 'x-turnstile-token': 'tok' });
    answer({ success: true, action: 'vneid_sign', hostname: 'kysoqr.example' });
    expect(await codeOf(() => verifyTurnstile(withToken, '203.0.113.1'))).toBeUndefined();

    vi.restoreAllMocks();
    answer({ success: true, action: 'other', hostname: 'kysoqr.example' });
    expect(await codeOf(() => verifyTurnstile(withToken, 'x'))).toBe('VNEID_CHALLENGE_FAILED');

    vi.restoreAllMocks();
    answer({ success: true, action: 'vneid_sign', hostname: 'evil.example' });
    expect(await codeOf(() => verifyTurnstile(withToken, 'x'))).toBe('VNEID_CHALLENGE_FAILED');

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network'));
    expect(await codeOf(() => verifyTurnstile(withToken, 'x'))).toBe('VNEID_CHALLENGE_FAILED');
  });
});

describe('perSecondLimit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps one client per second, then the whole service per second, and recovers a second later', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T00:00:00Z'));
    for (let i = 0; i < PER_IP_PER_SECOND; i += 1) {
      expect(perSecondLimit('sign', '203.0.113.1')).toBeNull();
    }
    const tooFast = perSecondLimit('sign', '203.0.113.1');
    expect(tooFast?.status).toBe(429);
    expect(tooFast?.headers.get('Retry-After')).toBe('1');

    // Many addresses at once: the service-wide cap of the route stops them.
    let allowed = PER_IP_PER_SECOND;
    for (let i = 2; i < 50; i += 1) {
      if (perSecondLimit('sign', `203.0.113.${i}`) === null) allowed += 1;
    }
    expect(allowed).toBe(SERVICE_PER_SECOND.sign);
    expect(perSecondLimit('status', '203.0.113.60')).toBeNull();

    vi.setSystemTime(new Date('2026-11-09T00:00:01.100Z'));
    expect(perSecondLimit('sign', '203.0.113.1')).toBeNull();
  });
});
