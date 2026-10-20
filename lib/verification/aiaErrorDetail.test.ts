import { describe, expect, it } from 'vitest';
import { describeAiaFailures } from './verifyPdfSignatures';

describe('describeAiaFailures (server-log detail for a chain that stopped short)', () => {
  it('names the URL, the real reason and the attempts', () => {
    expect(
      describeAiaFailures([
        { url: 'http://ca.example.test/sub.crt', attempts: 3, error: 'Guarded fetch: HTTP 503', stale: false },
      ])
    ).toBe('http://ca.example.test/sub.crt: Guarded fetch: HTTP 503 (3 attempts)');
  });

  it('marks a stale fallback and joins several failures', () => {
    expect(
      describeAiaFailures([
        { url: 'http://a.test/x.crt', attempts: 1, error: 'Guarded fetch to a.test timed out', stale: true },
        { url: null, error: 'boom', stale: false },
      ])
    ).toBe('http://a.test/x.crt: Guarded fetch to a.test timed out (1 attempt), used expired cached copy; (no URL): boom');
  });

  it('is undefined when nothing failed (no extra log field)', () => {
    expect(describeAiaFailures(undefined)).toBeUndefined();
    expect(describeAiaFailures([])).toBeUndefined();
  });
});
