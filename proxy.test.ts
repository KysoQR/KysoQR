import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, proxy } from './proxy';

const call = (url: string, headers: Record<string, string> = {}) =>
  proxy(new NextRequest(url, { headers: { host: 'localhost:3000', ...headers } }));
const location = (response: Response) => response.headers.get('location');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('proxy trailing-slash rules', () => {
  it('sends a page without a trailing slash to the one with it, keeping the query', () => {
    const response = call('http://localhost:3000/verify?code=abc');
    expect(response.status).toBe(308);
    expect(location(response)).toBe('http://localhost:3000/verify/?code=abc');
  });

  it('sends an /api path with a trailing slash to the one without', () => {
    const response = call('http://localhost:3000/api/sign/request/');
    expect(response.status).toBe(308);
    expect(location(response)).toBe('http://localhost:3000/api/sign/request');
  });

  it('always answers with an ABSOLUTE Location: Next parses it with new URL() and a relative one is a 500', () => {
    expect(() => new URL(location(call('http://localhost:3000/verify'))!)).not.toThrow();
  });

  it('lets canonical URLs, API paths, static files and the home page through', () => {
    for (const url of [
      'http://localhost/',
      'http://localhost/verify/',
      'http://localhost/api/sign/request',
      'http://localhost/why.html',
      'http://localhost/_next/static/x.js',
      'http://localhost/api/',
    ]) {
      expect(call(url).headers.get('location')).toBeNull();
    }
  });
});

describe('proxy redirects cannot be steered by the caller', () => {
  it('uses APP_ORIGIN, and ignores a forged Host and X-Forwarded-Proto, when it is set', () => {
    vi.stubEnv('APP_ORIGIN', 'https://kysoqr.example/');
    const forged = call('http://localhost:3000/verify?x=1', {
      host: 'evil.example',
      'x-forwarded-proto': 'javascript',
      'x-forwarded-host': 'evil.example',
    });
    expect(location(forged)).toBe('https://kysoqr.example/verify/?x=1');
  });

  it('without APP_ORIGIN, accepts only a plausible host and only http or https', () => {
    vi.stubEnv('APP_ORIGIN', '');
    expect(
      location(call('http://x/verify', { host: 'kysoqr.example', 'x-forwarded-proto': 'https' }))
    ).toBe('https://kysoqr.example/verify/');
    expect(
      location(
        call('http://x/verify', { host: 'kysoqr.example:8443', 'x-forwarded-proto': 'HTTPS' })
      )
    ).toBe('https://kysoqr.example:8443/verify/');
    expect(location(call('http://x/verify', { host: '[::1]:3000' }))).toBe(
      'http://[::1]:3000/verify/'
    );
    // Anything that could change what the URL means is refused.
    for (const host of [
      'evil.example/path',
      'user@evil.example',
      'evil.example#frag',
      'evil example',
      'evil.example:99999999',
      '-bad',
      'a..b/../c',
      '',
    ]) {
      expect(location(call('http://x/verify', { host }))).toBe('http://localhost/verify/');
    }
    expect(
      location(
        call('http://x/verify', { host: 'kysoqr.example', 'x-forwarded-proto': 'javascript' })
      )
    ).toBe('http://kysoqr.example/verify/');
  });

  it('keeps a path that starts with slashes or backslashes a path, never another host', () => {
    // No dots: a path with a dot is treated as a static file and never redirected.
    for (const url of [
      'http://localhost//evil',
      'http://localhost///evil/path',
      'http://localhost/\\evil',
      'http://localhost/\\\\evil/x',
    ]) {
      const header = location(call(url));
      expect(header).not.toBeNull();
      expect(new URL(header!).origin).toBe('http://localhost:3000');
    }
  });
});

describe('proxy matcher', () => {
  const matcher = new RegExp(`^${config.matcher[0]}$`);

  it('covers pages and the existing API, but not static assets or the VNeID routes', () => {
    for (const path of ['/', '/verify', '/api/sign/request', '/api/verify/upload'])
      expect(matcher.test(path)).toBe(true);
    for (const path of [
      '/_next/static/chunk.js',
      '/_next/image',
      '/api/vneid/sign',
      '/api/vneid/webhook',
      '/api/vneid/status',
    ]) {
      expect(matcher.test(path)).toBe(false);
    }
  });
});
