import { afterEach, describe, expect, it, vi } from 'vitest';
import { isVneidClientAllowed, vneidAccessDenied } from './access';

const from = (ip: string) => new Headers({ 'x-real-ip': ip });

describe('VNEID_TRUSTED_IPS', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const trust = (list: string, header = 'x-real-ip') => {
    vi.stubEnv('VNEID_TRUSTED_IPS', list);
    vi.stubEnv('TRUSTED_IP_HEADER', header);
  };

  it('lets everyone in while the list is empty', () => {
    trust('', '');
    expect(isVneidClientAllowed(new Headers())).toBe(true);
  });

  it('lets in single addresses and CIDR ranges, IPv4 and IPv6, and nobody else', () => {
    trust('203.0.113.5, 198.51.100.0/24,2001:db8:abcd::/48');
    expect(isVneidClientAllowed(from('203.0.113.5'))).toBe(true);
    expect(isVneidClientAllowed(from('203.0.113.6'))).toBe(false);
    expect(isVneidClientAllowed(from('198.51.100.200'))).toBe(true);
    expect(isVneidClientAllowed(from('198.51.101.1'))).toBe(false);
    expect(isVneidClientAllowed(from('2001:db8:abcd:12::1'))).toBe(true);
    expect(isVneidClientAllowed(from('2001:db8:abce::1'))).toBe(false);
    // An IPv4 client seen through an IPv6 socket.
    expect(isVneidClientAllowed(from('::ffff:203.0.113.5'))).toBe(true);
    expect(isVneidClientAllowed(new Headers())).toBe(false);
  });

  it('reads the client IP from TRUSTED_IP_HEADER only, never from headers a client writes', () => {
    trust('203.0.113.5');
    expect(
      isVneidClientAllowed(
        new Headers({ 'cf-connecting-ip': '203.0.113.5', 'x-forwarded-for': '203.0.113.5' })
      )
    ).toBe(false);
  });

  it('closes VNeID to everyone when the list cannot be trusted', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    trust('203.0.113.5', '');
    expect(isVneidClientAllowed(new Headers({ 'cf-connecting-ip': '203.0.113.5' }))).toBe(false);
    trust('203.0.113.5,not-an-ip');
    expect(isVneidClientAllowed(from('203.0.113.5'))).toBe(false);
    trust('203.0.113.0/33');
    expect(isVneidClientAllowed(from('203.0.113.5'))).toBe(false);
    expect(String(vi.mocked(console.error).mock.calls)).not.toContain('203.0.113');
  });

  it('answers an untrusted client with 403 VNEID_ACCESS_DENIED', async () => {
    trust('203.0.113.5');
    const request = (ip: string) =>
      new Request('http://localhost/api/vneid/sign', { headers: { 'x-real-ip': ip } });
    expect(vneidAccessDenied(request('203.0.113.5'))).toBeNull();
    const denied = vneidAccessDenied(request('192.0.2.1'))!;
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: 'VNEID_ACCESS_DENIED' });
  });
});
