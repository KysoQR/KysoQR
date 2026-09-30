import { describe, expect, it } from 'vitest';
import { checkRateLimit, rateLimitedResponse } from './rateLimit';

describe('checkRateLimit', () => {
  it('allows up to `limit` requests, then blocks with a positive retryAfterSeconds', () => {
    const key = `test-block:${Math.random()}`;
    const options = { limit: 3, windowMs: 60_000 };
    for (let i = 0; i < 3; i += 1) {
      expect(checkRateLimit(key, options)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    const blocked = checkRateLimit(key, options);
    expect(blocked.allowed).toBe(false);
    // One token refills every windowMs / limit = 20s.
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(20);
  });

  it('keeps separate buckets per key', () => {
    const options = { limit: 1, windowMs: 60_000 };
    const a = `test-a:${Math.random()}`;
    const b = `test-b:${Math.random()}`;
    expect(checkRateLimit(a, options).allowed).toBe(true);
    expect(checkRateLimit(a, options).allowed).toBe(false);
    expect(checkRateLimit(b, options).allowed).toBe(true);
  });
});

describe('rateLimitedResponse', () => {
  it('returns 429 RATE_LIMITED with a Retry-After header', async () => {
    const res = rateLimitedResponse(12);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('12');
    await expect(res.json()).resolves.toEqual({ error: 'RATE_LIMITED', message: 'Too many requests' });
  });
});
