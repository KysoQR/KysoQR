import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOX,
  createSamplePdf,
  createSoftIdentity,
  createTestTsa,
  signWithIdentity,
} from '../pdfSign/testHelpers';
import { verifyPdfSignatures } from '../verification/verifyPdfSignatures';
import { CsignError } from './csignClient';
import { VneidError } from './errors';
import {
  appearanceFor,
  configWarnings,
  authorizeFinalize,
  CONFIRM_WINDOW_MS,
  finalizeSigning,
  getStatus,
  resetVneidServiceForTests,
  startSigning,
  type StartSigningInput,
  TRANSACTION_TTL_MS,
} from './service';
import { CITIZEN_PID, createTestContext, type TestContext, vneidIdentity } from './testKit';
import { requestTimestamp, setTsaTrustedRootsForTests, TsaError } from './tsa';

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest();

async function codeOf(run: () => Promise<unknown> | unknown): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof VneidError) return error.code;
    throw error;
  }
  return undefined;
}

describe('VNeID signing service', () => {
  let pdf: Buffer;
  let logs: string[];

  beforeAll(async () => {
    pdf = await createSamplePdf();
  });

  beforeEach(() => {
    resetVneidServiceForTests();
    logs = [];
    for (const level of ['error', 'warn', 'log', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(
          args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
        );
      });
    }
  });

  afterEach(() => {
    // Whatever happened, the CCCD never reached a log line.
    expect(logs.join('\n')).not.toContain(CITIZEN_PID);
    vi.restoreAllMocks();
  });

  const start = (ctx: TestContext, overrides: Partial<StartSigningInput> = {}) =>
    startSigning(ctx.deps, {
      pdf,
      fields: [BOX],
      citizenPid: CITIZEN_PID,
      language: 'vi',
      clientIp: '203.0.113.5',
      ...overrides,
    });

  /** Runs a request to SIGNED through status polling, the way the UI would. */
  async function signThroughPolling(ctx: TestContext, input: Buffer) {
    const started = await start(ctx, { pdf: input });
    const ticket = { transactionId: started.transactionId, clientSecret: started.clientSecret };
    ctx.csign.complete();
    expect((await getStatus(ctx.deps, ticket)).status).toBe('SIGNED');
    return { started, ticket };
  }

  it('signs a PDF end to end: push, polling, finalize, and the result verifies', async () => {
    const ctx = createTestContext();
    const started = await start(ctx);
    expect(started.transactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(started.confirmDeadline - ctx.clock.now).toBe(CONFIRM_WINDOW_MS);
    expect(started.expiresAt - ctx.clock.now).toBe(TRANSACTION_TTL_MS);
    expect(started.codeRequired).toBe(false);

    const request = ctx.csign.lastRequest;
    expect(request.citizenPid).toBe(CITIZEN_PID);
    expect(request.documentName).toMatch(/^KysoQR - Ký tài liệu [0-9A-F]{8}$/);
    expect(Buffer.from(request.digestValue, 'base64')).toHaveLength(32);
    // Nothing the browser sent became an identifier at CSign.
    expect([request.requestId, request.documentId]).not.toContain(started.transactionId);

    const ticket = { transactionId: started.transactionId, clientSecret: started.clientSecret };
    ctx.csign.status = {
      statusCode: 3,
      resultCode: undefined,
      errorCode: undefined,
      signatures: [],
    };
    expect((await getStatus(ctx.deps, ticket)).status).toBe('WAITING_USER');
    ctx.csign.complete();
    // Polled again too soon: CSign is not asked.
    expect((await getStatus(ctx.deps, ticket)).status).toBe('WAITING_USER');
    expect(ctx.csign.statusQueries).toHaveLength(1);
    ctx.clock.advance(15_000);
    expect((await getStatus(ctx.deps, ticket)).status).toBe('SIGNED');

    expect(authorizeFinalize(ctx.deps, ticket)).toEqual({ originalLength: pdf.length });
    const signed = await finalizeSigning(ctx.deps, { ...ticket, original: pdf });
    expect(signed.subarray(0, pdf.length).equals(pdf)).toBe(true);
    const results = await verifyPdfSignatures(signed, ctx.identity.trustStore);
    expect(results.map((result) => result.status)).toEqual(['SIGNED_VALID']);
    expect((await getStatus(ctx.deps, ticket)).status).toBe('FINALIZED');

    // Finalizing again gives the same file (a lost download can be retried).
    expect((await finalizeSigning(ctx.deps, { ...ticket, original: pdf })).equals(signed)).toBe(
      true
    );
  });

  it('stamps the signature once, at the first finalize, and the file still verifies', async () => {
    const tsa = createTestTsa();
    setTsaTrustedRootsForTests([tsa.identity.rootPem]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input, init) =>
        new Response(new Uint8Array(await tsa.respond(Buffer.from(init!.body as Uint8Array))), {
          status: 200,
        })
    );
    const ctx = createTestContext();
    ctx.deps.tsa = (signature) =>
      requestTimestamp(signature, { url: 'http://tsa.example.test', now: () => ctx.clock.now });
    const { ticket } = await signThroughPolling(ctx, pdf);

    const signed = await finalizeSigning(ctx.deps, { ...ticket, original: pdf });
    const token = ctx.deps.store.get(ticket.transactionId)!.timestampToken!;
    expect(token).toBeInstanceOf(Buffer);
    expect(signed.toString('latin1')).toContain(token.toString('hex').toUpperCase());
    const results = await verifyPdfSignatures(signed, ctx.identity.trustStore);
    expect(results.map((result) => result.status)).toEqual(['SIGNED_VALID']);
    expect(logs.some((line) => line.includes('[vneid:tsa] timestamp obtained'))).toBe(true);

    // A later download embeds the same token; the TSA is not asked again.
    expect((await finalizeSigning(ctx.deps, { ...ticket, original: pdf })).equals(signed)).toBe(
      true
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('still gives the signed file when the TSA fails or its token cannot be used', async () => {
    const failing = createTestContext();
    failing.deps.tsa = async () => {
      throw new TsaError('HTTP 503');
    };
    const first = await signThroughPolling(failing, pdf);
    const plain = await finalizeSigning(failing.deps, { ...first.ticket, original: pdf });
    expect(
      (await verifyPdfSignatures(plain, failing.identity.trustStore)).map((r) => r.status)
    ).toEqual(['SIGNED_VALID']);
    expect(failing.deps.store.get(first.ticket.transactionId)!.timestampToken).toBeNull();
    expect(logs.some((line) => line.includes('no timestamp, signing without one'))).toBe(true);

    // A token over some other signature is refused when embedding.
    const tsa = createTestTsa();
    setTsaTrustedRootsForTests([tsa.identity.rootPem]);
    const wrong = createTestContext();
    wrong.deps.tsa = async () => ({
      tokenDer: await tsa.token(randomBytes(256)),
      genTime: new Date(),
    });
    const second = await signThroughPolling(wrong, pdf);
    const signed = await finalizeSigning(wrong.deps, { ...second.ticket, original: pdf });
    expect(
      (await verifyPdfSignatures(signed, wrong.identity.trustStore)).map((r) => r.status)
    ).toEqual(['SIGNED_VALID']);
    expect(logs.some((line) => line.includes('timestamp not embedded'))).toBe(true);
  });

  it('keeps earlier signatures intact, for both xref flavours', async () => {
    for (const objectStreams of [false, true]) {
      const someone = createSoftIdentity({ commonName: 'Earlier Signer' });
      const another = createSoftIdentity({ commonName: 'Second Signer' });
      const base = await createSamplePdf({ objectStreams });
      const once = (await signWithIdentity(base, someone)).signed;
      const twice = (await signWithIdentity(once, another, { fields: [{ ...BOX, yRatio: 0.6 }] }))
        .signed;

      const ctx = createTestContext();
      const started = await start(ctx, { pdf: twice, fields: [{ ...BOX, yRatio: 0.4 }] });
      const ticket = { transactionId: started.transactionId, clientSecret: started.clientSecret };
      ctx.csign.complete();
      await getStatus(ctx.deps, ticket);
      const signed = await finalizeSigning(ctx.deps, { ...ticket, original: twice });

      const results = await verifyPdfSignatures(signed, ctx.identity.trustStore);
      expect(results).toHaveLength(3);
      expect(results.slice(0, 2).every((result) => result.contentIntact === true)).toBe(true);
      expect(results[2]!.status).toBe('SIGNED_VALID');
      // Each earlier signature still verifies under its own trust.
      expect((await verifyPdfSignatures(signed, someone.trustStore))[0]!.status).toBe(
        'SIGNED_VALID'
      );
      expect((await verifyPdfSignatures(signed, another.trustStore))[1]!.status).toBe(
        'SIGNED_VALID'
      );
    }
  });

  it('refuses the wrong PDF, the wrong secret and a premature finalize', async () => {
    const ctx = createTestContext();
    const started = await start(ctx);
    const ticket = { transactionId: started.transactionId, clientSecret: started.clientSecret };
    expect(await codeOf(() => authorizeFinalize(ctx.deps, ticket))).toBe('VNEID_NOT_READY');

    ctx.csign.complete();
    await getStatus(ctx.deps, ticket);
    const other = await createSamplePdf({ pages: [{ text: 'another document' }] });
    expect(await codeOf(() => finalizeSigning(ctx.deps, { ...ticket, original: other }))).toBe(
      'VNEID_DOCUMENT_MISMATCH'
    );
    const tampered = Buffer.from(pdf);
    tampered[tampered.length - 20]! ^= 1;
    expect(await codeOf(() => finalizeSigning(ctx.deps, { ...ticket, original: tampered }))).toBe(
      'VNEID_DOCUMENT_MISMATCH'
    );

    for (const wrong of [
      { ...ticket, clientSecret: 'A'.repeat(43) },
      { ...ticket, clientSecret: 'short' },
      { ...ticket, transactionId: '00000000-0000-4000-8000-000000000000' },
      { ...ticket, transactionId: 'not-a-uuid' },
    ]) {
      expect(await codeOf(() => getStatus(ctx.deps, wrong))).toBe('VNEID_NOT_FOUND');
      expect(await codeOf(() => finalizeSigning(ctx.deps, { ...wrong, original: pdf }))).toBe(
        'VNEID_NOT_FOUND'
      );
    }
  });

  it('allows one open request per citizen, and frees it when CSign says another is pending', async () => {
    const ctx = createTestContext();
    await start(ctx);
    expect(await codeOf(() => start(ctx))).toBe('VNEID_REQUEST_PENDING');
    expect(ctx.csign.signRequests).toHaveLength(1);

    const fresh = createTestContext();
    fresh.csign.signHashError = new CsignError(
      'PENDING_OTHER',
      '/api/signing/sign-hash',
      'refused',
      {
        code: '-01',
      }
    );
    expect(await codeOf(() => start(fresh))).toBe('VNEID_REQUEST_PENDING');
    fresh.csign.signHashError = undefined;
    await expect(start(fresh)).resolves.toBeDefined();
  });

  it('signs under a test (UAT) root no store holds, and the file passes the self-check', async () => {
    // (Not another test identity's store: all test roots share one name,
    // which confuses chain building.)
    const uat = createTestContext();
    uat.deps.trustStore = {
      isConfigured: () => true,
      isTrustedRoot: () => false,
      getTrustedRootPems: () => [],
    };
    const { ticket } = await signThroughPolling(uat, pdf);
    const signed = await finalizeSigning(uat.deps, { ...ticket, original: pdf });
    expect((await verifyPdfSignatures(signed, uat.identity.trustStore))[0]!.status).toBe(
      'SIGNED_VALID'
    );
    expect(logs.some((line) => line.includes('not a national root'))).toBe(true);
    expect(logs.join('\n')).not.toContain('Nguyen Van Test');

    const nobody = createTestContext();
    nobody.csign.credentials = [];
    expect(await codeOf(() => start(nobody))).toBe('VNEID_NO_CERTIFICATE');
    const someoneElse = createTestContext({ identity: vneidIdentity('079123456789') });
    expect(await codeOf(() => start(someoneElse))).toBe('VNEID_CERT_INVALID');
  });

  it('never stores a signature over anything else, and says why in one log line', async () => {
    const ctx = createTestContext();
    const started = await start(ctx);
    const ticket = { transactionId: started.transactionId, clientSecret: started.clientSecret };
    ctx.csign.complete(ctx.csign.sign((digest) => sha256(digest)));
    const view = await getStatus(ctx.deps, ticket);
    expect(view).toMatchObject({ status: 'FAILED', reason: 'SIGNATURE_UNUSABLE' });
    expect(logs.some((line) => line.includes('VNEID_SIGNATURE_DIAGNOSIS=REHASHED'))).toBe(true);
    expect(await codeOf(() => finalizeSigning(ctx.deps, { ...ticket, original: pdf }))).toBe(
      'VNEID_NOT_READY'
    );
  });

  it('takes the one signature CSign tagged with a documentId of its own', async () => {
    const ctx = createTestContext();
    const started = await start(ctx);
    const ticket = { transactionId: started.transactionId, clientSecret: started.clientSecret };
    // What the UAT gateway answered: "Ký thành công", under its own id.
    ctx.csign.complete();
    ctx.csign.status.signatures[0]!.documentId = '7df24769-94f1-4f92-bab5-4046c5deb981';
    expect((await getStatus(ctx.deps, ticket)).status).toBe('SIGNED');
    expect(logs.some((line) => line.includes('7df24769-94f1-4f92-bab5-4046c5deb981'))).toBe(true);

    const signed = await finalizeSigning(ctx.deps, { ...ticket, original: pdf });
    const results = await verifyPdfSignatures(signed, ctx.identity.trustStore);
    expect(results.map((result) => result.status)).toEqual(['SIGNED_VALID']);
  });

  it('refuses a foreign-tagged signature over other data, and waits when several match nothing', async () => {
    const ctx = createTestContext();
    const started = await start(ctx);
    const ticket = { transactionId: started.transactionId, clientSecret: started.clientSecret };
    const good = ctx.csign.sign();
    ctx.csign.status = {
      statusCode: 4,
      resultCode: 'Ký thành công',
      errorCode: undefined,
      signatures: [
        { documentId: 'other-1', signature: good },
        { documentId: 'other-2', signature: good },
      ],
    };
    expect((await getStatus(ctx.deps, ticket)).status).toBe('PENDING');
    expect(logs.some((line) => line.includes('no signature matches'))).toBe(true);

    ctx.csign.status = {
      ...ctx.csign.status,
      signatures: [{ documentId: 'other-1', signature: ctx.csign.sign((d) => sha256(d)) }],
    };
    ctx.clock.advance(5_000);
    expect(await getStatus(ctx.deps, ticket)).toMatchObject({
      status: 'FAILED',
      reason: 'SIGNATURE_UNUSABLE',
    });
  });

  it('keeps asking CSign once a minute after the confirm window, and expires on its own', async () => {
    const ctx = createTestContext();
    const started = await start(ctx);
    const ticket = { transactionId: started.transactionId, clientSecret: started.clientSecret };
    // Inside the confirm window: at most every 5 seconds.
    expect((await getStatus(ctx.deps, ticket)).status).toBe('PENDING');
    expect((await getStatus(ctx.deps, ticket)).status).toBe('PENDING');
    expect(ctx.csign.statusQueries).toHaveLength(1);
    ctx.clock.advance(5_000);
    await getStatus(ctx.deps, ticket);
    expect(ctx.csign.statusQueries).toHaveLength(2);

    // After it: once a minute, so a late result still arrives without a webhook.
    ctx.clock.advance(CONFIRM_WINDOW_MS + 61_000);
    await getStatus(ctx.deps, ticket);
    expect(ctx.csign.statusQueries).toHaveLength(3);
    ctx.clock.advance(30_000);
    await getStatus(ctx.deps, ticket);
    expect(ctx.csign.statusQueries).toHaveLength(3);
    ctx.clock.advance(30_000);
    ctx.csign.complete();
    expect((await getStatus(ctx.deps, ticket)).status).toBe('SIGNED');
    expect(ctx.csign.statusQueries).toHaveLength(4);
  });

  it('expires on its own and then stops asking CSign', async () => {
    const ctx = createTestContext();
    const started = await start(ctx);
    const ticket = { transactionId: started.transactionId, clientSecret: started.clientSecret };
    ctx.clock.advance(TRANSACTION_TTL_MS + 1);
    expect(await getStatus(ctx.deps, ticket)).toMatchObject({
      status: 'EXPIRED',
      reason: 'TIMEOUT',
    });
    expect(ctx.csign.statusQueries).toHaveLength(0);
    await expect(start(ctx)).resolves.toBeDefined();
  });

  it('pauses a citizen whose requests keep being refused, but never counts successes', async () => {
    const ctx = createTestContext();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const started = await start(ctx);
      ctx.csign.status = {
        statusCode: 5,
        resultCode: undefined,
        errorCode: 'errorcode4004',
        signatures: [],
      };
      ctx.clock.advance(15_000);
      const view = await getStatus(ctx.deps, {
        transactionId: started.transactionId,
        clientSecret: started.clientSecret,
      });
      expect(view).toMatchObject({ status: 'REJECTED', reason: 'REFUSED' });
    }
    expect(await codeOf(() => start(ctx))).toBe('VNEID_CITIZEN_LIMITED');
    ctx.clock.advance(61 * 60_000);
    await expect(start(ctx)).resolves.toBeDefined();
  });

  it('tells an identity-service (TTXT) failure apart from other provider errors', async () => {
    const ctx = createTestContext();
    const failWith = async (errorCode: string, citizenPid?: string) => {
      const started = await start(ctx, citizenPid ? { citizenPid } : {});
      ctx.csign.status = { statusCode: 0, resultCode: undefined, errorCode, signatures: [] };
      ctx.clock.advance(15_000);
      return getStatus(ctx.deps, {
        transactionId: started.transactionId,
        clientSecret: started.clientSecret,
      });
    };
    // What the UAT gateway answered: "Lỗi kết nối tới TTXT, vui lòng thử lại sau".
    expect(await failWith('errorcode4001')).toMatchObject({
      status: 'FAILED',
      reason: 'IDENTITY_SERVICE',
    });
    expect(await failWith('errorcode4009')).toMatchObject({ status: 'FAILED', reason: 'PROVIDER' });
  });

  it('enforces the service-wide daily cap', async () => {
    const ctx = createTestContext({ config: { dailyCap: 1 } });
    await start(ctx);
    expect(await codeOf(() => start(ctx, { citizenPid: '079123456789' }))).toBe('VNEID_DAILY_CAP');
  });

  it('asks for the code shown on VNeID when codes are on, and burns after five misses', async () => {
    const ctx = createTestContext({ config: { requireCode: true } });
    const { started, ticket } = await signThroughPolling(ctx, pdf);
    expect(started.codeRequired).toBe(true);
    const code = /Mã ([A-Z0-9]{6})$/.exec(ctx.csign.lastRequest.documentName)?.[1];
    expect(code).toBeDefined();

    expect(await codeOf(() => authorizeFinalize(ctx.deps, ticket))).toBe('VNEID_CODE_INVALID');
    const signed = await finalizeSigning(ctx.deps, {
      ...ticket,
      code: code!.toLowerCase(),
      original: pdf,
    });
    expect((await verifyPdfSignatures(signed, ctx.identity.trustStore))[0]!.status).toBe(
      'SIGNED_VALID'
    );

    const second = createTestContext({ config: { requireCode: true } });
    const burned = await signThroughPolling(second, pdf);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await codeOf(() => authorizeFinalize(second.deps, { ...burned.ticket, code: 'ZZZZZZ' }))
      ).toBe('VNEID_CODE_INVALID');
    }
    expect(await getStatus(second.deps, burned.ticket)).toMatchObject({
      status: 'FAILED',
      reason: 'CODE_ATTEMPTS',
    });
  });

  it('rejects bad input before doing any work', async () => {
    const ctx = createTestContext();
    expect(await codeOf(() => start(ctx, { citizenPid: '12345' }))).toBe('VNEID_INVALID_INPUT');
    expect(await codeOf(() => start(ctx, { citizenPid: '999123456789' }))).toBe(
      'VNEID_INVALID_INPUT'
    );
    expect(await codeOf(() => start(ctx, { fields: [] }))).toBe('VNEID_INVALID_INPUT');
    expect(await codeOf(() => start(ctx, { fields: [{ ...BOX, xRatio: 0.9 }] }))).toBe(
      'VNEID_INVALID_INPUT'
    );
    expect(await codeOf(() => start(ctx, { fields: [{ ...BOX, page: 3 }] }))).toBe(
      'VNEID_INVALID_INPUT'
    );
    expect(await codeOf(() => start(ctx, { pdf: Buffer.from('%PDF-1.7 not really') }))).toBe(
      'VNEID_PDF_REJECTED'
    );
    expect(ctx.csign.signRequests).toHaveLength(0);
  });
});

describe('configWarnings', () => {
  it('names what leaves production open, and says nothing in development', () => {
    vi.stubEnv('TURNSTILE_SECRET', '');
    const config = createTestContext().deps.config;
    const open = {
      ...config,
      requireCode: false,
      webhook: { organizationId: 'org', secrets: ['abc123'] },
    };
    const production = configWarnings(open, true).join('\n');
    expect(production).toMatch(/TURNSTILE_SECRET/);
    expect(production).toMatch(/VNEID_REQUIRE_CODE/);
    expect(production).toMatch(/CSIGN_WEBHOOK_SECRET/);
    expect(production).not.toContain('abc123');
    expect(configWarnings({ ...open, webhook: undefined }, false)).toEqual([]);
    vi.unstubAllEnvs();
  });
});

describe('appearanceFor', () => {
  const NBSP = String.fromCharCode(0xa0);

  it('writes the date and time in Vietnam time, to the second of /M, under VNeID and kysoqr.com', () => {
    // /M of this instant is D:20261009034217Z (seconds are cut, not rounded).
    const at = Date.UTC(2026, 9, 9, 3, 42, 17, 900);
    expect(appearanceFor('Nguyễn Văn A', 'vi', at)).toEqual({
      name: 'Nguyễn Văn A',
      details: [`Ngày ký:${NBSP}09/10/2026`, `Giờ ký:${NBSP}10:42:17${NBSP}(+07:00)`],
      logoCaption: 'Ký bằng VNeID',
      note: 'Ký bằng kysoqr.com',
    });
    // Past midnight in Vietnam while still the old year in UTC.
    expect(appearanceFor('A', 'en', Date.UTC(2026, 11, 31, 17, 0, 5))).toMatchObject({
      details: [`Date:${NBSP}01/01/2027`, `Time:${NBSP}00:00:05${NBSP}(+07:00)`],
      logoCaption: 'Signed with VNeID',
      note: 'Signed with kysoqr.com',
    });
  });
});
