import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readTimestampToken } from '../pdfSign/cms';
import { createTestTsa, type TestTsa, type TestTsaAnswer } from '../pdfSign/testHelpers';
import {
  buildTimestampRequest,
  newNonce,
  requestTimestamp,
  setTsaTrustedRootsForTests,
  timestampFromAny,
  TsaError,
} from './tsa';

const URL = 'http://tsa.example.test/tsr';

describe('requestTimestamp', () => {
  let tsa: TestTsa;
  const signature = randomBytes(256);

  beforeAll(() => {
    tsa = createTestTsa();
    setTsaTrustedRootsForTests([tsa.identity.rootPem]);
  });

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** fetch answers like a TSA would, optionally misbehaving. */
  function answerWith(answer: TestTsaAnswer = {}, init: ResponseInit = {}) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, request) => {
      const body = Buffer.from(request!.body as Uint8Array);
      return new Response(new Uint8Array(await tsa.respond(body, answer)), {
        status: 200,
        headers: { 'content-type': 'application/timestamp-reply' },
        ...init,
      });
    });
  }

  async function failureOf(run: () => Promise<unknown>): Promise<string> {
    try {
      await run();
    } catch (error) {
      if (error instanceof TsaError) return error.message;
      throw error;
    }
    return 'no error';
  }

  it('refuses a token signed by a TSA it does not trust (e.g. one injected on an http path)', async () => {
    const stranger = createTestTsa();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, request) => {
      const body = Buffer.from(request!.body as Uint8Array);
      return new Response(new Uint8Array(await stranger.respond(body)), { status: 200 });
    });
    expect(await failureOf(() => requestTimestamp(signature, { url: URL }))).toMatch(/not trusted/);
  });

  it('returns a checked token over SHA-256 of the signature', async () => {
    const fetchSpy = answerWith();
    const stamp = await requestTimestamp(signature, { url: URL });
    expect(Math.abs(stamp.genTime.getTime() - Date.now())).toBeLessThan(60_000);
    const token = readTimestampToken(stamp.tokenDer);
    expect(token.imprint).toEqual(createHash('sha256').update(signature).digest());

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(URL);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe(
      'application/timestamp-query'
    );
  });

  it('builds a DER request with a positive, minimal nonce', () => {
    for (let i = 0; i < 20; i += 1) {
      const nonce = newNonce();
      expect(nonce).toHaveLength(8);
      expect(nonce[0]! & 0x80).toBe(0);
      expect(nonce[0]).not.toBe(0);
    }
    expect(buildTimestampRequest(signature, newNonce())[0]).toBe(0x30);
  });

  it('refuses tokens that do not answer this request', async () => {
    answerWith({ nonce: randomBytes(8) });
    expect(await failureOf(() => requestTimestamp(signature, { url: URL }))).toMatch(/nonce/);
    vi.restoreAllMocks();

    answerWith({ nonce: null });
    expect(await failureOf(() => requestTimestamp(signature, { url: URL }))).toMatch(/nonce/);
    vi.restoreAllMocks();

    answerWith({ imprint: randomBytes(32) });
    expect(await failureOf(() => requestTimestamp(signature, { url: URL }))).toMatch(
      /something else/
    );
    vi.restoreAllMocks();

    answerWith({ genTime: new Date(Date.now() - 10 * 60_000) });
    expect(await failureOf(() => requestTimestamp(signature, { url: URL }))).toMatch(/too far/);
    vi.restoreAllMocks();

    answerWith({ tamper: true });
    expect(await failureOf(() => requestTimestamp(signature, { url: URL }))).toMatch(
      /does not verify/
    );
  });

  it('refuses a rejection, an HTTP error, an oversized or broken answer', async () => {
    answerWith({ status: 2 });
    expect(await failureOf(() => requestTimestamp(signature, { url: URL }))).toMatch(
      /not granted \(status 2\)/
    );
    vi.restoreAllMocks();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('busy', { status: 503 }));
    expect(await failureOf(() => requestTimestamp(signature, { url: URL }))).toBe('HTTP 503');
    vi.restoreAllMocks();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array(70 * 1024), { status: 200 })
    );
    expect(await failureOf(() => requestTimestamp(signature, { url: URL }))).toMatch(/too large/);
    vi.restoreAllMocks();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 200 }));
    expect(await failureOf(() => requestTimestamp(signature, { url: URL }))).toMatch(
      /not a TimeStampResp/
    );
  });

  it('reports a timeout and a network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' })
    );
    expect(await failureOf(() => requestTimestamp(signature, { url: URL }))).toBe(
      'no answer in time'
    );
    vi.restoreAllMocks();

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    expect(await failureOf(() => requestTimestamp(signature, { url: URL }))).toBe('request failed');
  });
});

describe('timestampFromAny', () => {
  let tsa: TestTsa;
  const signature = randomBytes(256);
  const FIRST = 'http://tsa-a.example.test/tsr';
  const SECOND = 'http://tsa-b.example.test/tsr';

  beforeAll(() => {
    tsa = createTestTsa();
    setTsaTrustedRootsForTests([tsa.identity.rootPem]);
  });

  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Each TSA answers on its own: like a TSA (optionally misbehaving), or with an HTTP error. */
  function serve(answers: Record<string, TestTsaAnswer | number>) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, request) => {
      const answer = answers[String(input)] ?? {};
      if (typeof answer === 'number') return new Response('down', { status: answer });
      const body = Buffer.from(request!.body as Uint8Array);
      return new Response(new Uint8Array(await tsa.respond(body, answer)), { status: 200 });
    });
  }

  const askedUrls = (fetchSpy: ReturnType<typeof serve>) =>
    fetchSpy.mock.calls.map(([url]) => String(url));

  it('uses the first TSA when it answers, without asking the second', async () => {
    const fetchSpy = serve({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stamp = await timestampFromAny([FIRST, SECOND])(signature);
    expect(readTimestampToken(stamp.tokenDer).imprint).toEqual(
      createHash('sha256').update(signature).digest()
    );
    expect(askedUrls(fetchSpy)).toEqual([FIRST]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the second TSA when the first is down or answers something unusable', async () => {
    for (const first of [503, { nonce: randomBytes(8) }]) {
      const fetchSpy = serve({ [FIRST]: first });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const stamp = await timestampFromAny([FIRST, SECOND])(signature);
      expect(readTimestampToken(stamp.tokenDer).imprint).toEqual(
        createHash('sha256').update(signature).digest()
      );
      expect(askedUrls(fetchSpy)).toEqual([FIRST, SECOND]);
      expect(warn).toHaveBeenCalledWith(
        '[vneid:tsa] TSA failed, trying the next one',
        expect.objectContaining({ tsa: 'tsa-a.example.test' })
      );
      vi.restoreAllMocks();
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
    }
  });

  it('names every TSA and why when none gives a timestamp', async () => {
    serve({ [FIRST]: 503, [SECOND]: { status: 2 } });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(timestampFromAny([FIRST, SECOND])(signature)).rejects.toThrow(
      'tsa-a.example.test: HTTP 503; tsa-b.example.test: request not granted (status 2)'
    );
    expect(() => timestampFromAny([])).toThrow(TsaError);
  });
});
