import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkRateLimit,
  clientIpFromRequest,
  normalizeClientIp,
  rateLimitedResponse,
} from './rateLimit';

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
    await expect(res.json()).resolves.toEqual({
      error: 'RATE_LIMITED',
      message: 'Too many requests',
    });
  });
});

describe('checkRateLimit table size', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a new key once 50,000 are being limited, keeps limiting the old ones, and recovers when they go idle', async () => {
    // A fresh module: the other tests' keys must not count against the cap.
    vi.resetModules();
    const { checkRateLimit: check } = await import('./rateLimit');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
    const options = { limit: 1, windowMs: 1_000 };

    for (let i = 0; i < 50_000; i += 1) expect(check(`flood:${i}`, options).allowed).toBe(true);
    // The table is full of keys that are still inside their window.
    const refused = check('newcomer', options);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    // Keys already tracked keep their own state.
    expect(check('flood:0', options).allowed).toBe(false);

    // A window later every bucket has refilled, so they are swept and a new key fits.
    vi.setSystemTime(new Date('2026-11-03T00:00:02Z'));
    expect(check('newcomer', options).allowed).toBe(true);
    expect(check('flood:1', options).allowed).toBe(true);
  });
});

describe('normalizeClientIp', () => {
  it('keeps IPv4 addresses and drops any port', () => {
    expect(normalizeClientIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIp('  203.0.113.7  ')).toBe('203.0.113.7');
    expect(normalizeClientIp('203.0.113.7:51234')).toBe('203.0.113.7');
    expect(normalizeClientIp('001.002.003.004')).toBe('1.2.3.4');
  });

  it('keys an IPv6 client by its /64, so rotating inside it gains nothing', () => {
    const a = normalizeClientIp('2001:db8:abcd:12::1');
    const b = normalizeClientIp('2001:DB8:ABCD:12:ffff:ffff:ffff:ffff');
    expect(a).toBe('2001:db8:abcd:12::/64');
    expect(b).toBe(a);
    expect(normalizeClientIp('2001:db8:abcd:13::1')).not.toBe(a);
    expect(normalizeClientIp('[2001:db8:abcd:12::1]:443')).toBe(a);
    expect(normalizeClientIp('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(normalizeClientIp('::1')).toBe('0:0:0:0::/64');
  });

  it('turns an IPv4-mapped IPv6 address back into the IPv4 it wraps', () => {
    expect(normalizeClientIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIp('::ffff:cb00:7107')).toBe('203.0.113.7');
  });

  it('rejects anything that is not an IP address instead of using it as a key', () => {
    for (const junk of [
      '',
      '   ',
      'abc',
      '1.2.3',
      '256.1.1.1',
      '1.2.3.4.5',
      'gggg::1',
      '1:2:3:4:5:6:7:8:9',
      ':::',
      '1::2::3',
      '203.0.113.7/24',
      "1.1.1.1'; DROP",
      'unknown',
    ]) {
      expect(normalizeClientIp(junk)).toBeUndefined();
    }
    expect(normalizeClientIp(null)).toBeUndefined();
    expect(normalizeClientIp(undefined)).toBeUndefined();
  });
});

describe('clientIpFromRequest', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const request = (headers: Record<string, string>) =>
    new Request('http://localhost/api/x', { headers });

  describe('without TRUSTED_IP_HEADER (Cloudflare Worker / older setups)', () => {
    it('trusts CF-Connecting-IP first, then the last X-Forwarded-For entry', () => {
      expect(
        clientIpFromRequest(
          request({ 'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })
        )
      ).toBe('198.51.100.9');
      expect(clientIpFromRequest(request({ 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }))).toBe(
        '203.0.113.7'
      );
      expect(clientIpFromRequest(request({}))).toBe('unknown');
    });

    it('turns a malformed value into the shared "unknown" bucket', () => {
      expect(clientIpFromRequest(request({ 'cf-connecting-ip': 'not an ip' }))).toBe('unknown');
      expect(clientIpFromRequest(request({ 'x-forwarded-for': '203.0.113.7, <script>' }))).toBe(
        'unknown'
      );
    });
  });

  describe('with TRUSTED_IP_HEADER (VPS behind nginx)', () => {
    it('reads only that header, whatever else the client sends', () => {
      vi.stubEnv('TRUSTED_IP_HEADER', 'x-real-ip');
      const spoofed = request({
        'x-real-ip': '203.0.113.7',
        'cf-connecting-ip': '1.2.3.4',
        'x-forwarded-for': '5.6.7.8',
      });
      expect(clientIpFromRequest(spoofed)).toBe('203.0.113.7');
      // The header the client controls cannot move it to another bucket.
      expect(
        clientIpFromRequest(
          request({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' })
        )
      ).toBe('unknown');
    });

    it('matches the header name case-insensitively and ignores surrounding spaces', () => {
      vi.stubEnv('TRUSTED_IP_HEADER', '  X-Real-IP ');
      expect(clientIpFromRequest(request({ 'x-real-ip': '203.0.113.7' }))).toBe('203.0.113.7');
    });

    it('can name any header, e.g. cf-connecting-ip on a Worker', () => {
      vi.stubEnv('TRUSTED_IP_HEADER', 'cf-connecting-ip');
      expect(
        clientIpFromRequest(
          request({ 'cf-connecting-ip': '2001:db8:1:2::9', 'x-real-ip': '1.1.1.1' })
        )
      ).toBe('2001:db8:1:2::/64');
    });
  });
});
