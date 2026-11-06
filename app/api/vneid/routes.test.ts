import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSamplePdf } from '@/lib/pdfSign/testHelpers';
import { verifyPdfSignatures } from '@/lib/verification/verifyPdfSignatures';
import { VneidError } from '@/lib/vneid/errors';
import type { VneidDeps } from '@/lib/vneid/service';
import {
  CITIZEN_PID,
  createTestContext,
  type TestContext,
  webhookDelivery,
} from '@/lib/vneid/testKit';

let currentDeps: () => VneidDeps;

vi.mock('@/lib/vneid/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/vneid/service')>();
  return { ...actual, getVneidDeps: () => currentDeps() };
});

const { POST: sign } = await import('./sign/route');
const { POST: status } = await import('./status/route');
const { POST: finalize } = await import('./finalize/route');
const { POST: webhook } = await import('./webhook/route');
const { POST: credentials } = await import('./credentials/route');
const { GET: providers } = await import('./providers/route');
const { POST: register } = await import('./registrations/route');
const { POST: registration } = await import('./registrations/status/route');
const { resetVneidServiceForTests } = await import('@/lib/vneid/service');

const ORIGIN = 'http://localhost:3000';
const FIELDS = JSON.stringify([
  { page: 1, xRatio: 0.55, yRatio: 0.78, widthRatio: 0.34, heightRatio: 0.1 },
]);
let ipCounter = 0;

/** A multipart request as a browser sends it, with a real Content-Length. */
async function signRequest(
  pdf: Buffer,
  fields: Record<string, string> = {},
  headers: Record<string, string | null> = {}
): Promise<Request> {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(pdf)], 'hop-dong.pdf', { type: 'application/pdf' }));
  form.append('citizenPid', fields.citizenPid ?? CITIZEN_PID);
  form.append('signatureFields', fields.signatureFields ?? FIELDS);
  form.append('language', fields.language ?? 'vi');
  if (fields.credentialId !== undefined) form.append('credentialId', fields.credentialId);
  const encoded = new Request('http://localhost/encode', { method: 'POST', body: form });
  const body = Buffer.from(await encoded.arrayBuffer());
  return buildRequest('sign', body, {
    'content-type': encoded.headers.get('content-type'),
    'content-length': String(body.length),
    ...headers,
  });
}

function buildRequest(
  route: string,
  body: Uint8Array,
  headers: Record<string, string | null>
): Request {
  ipCounter += 1;
  const merged: Record<string, string> = {
    origin: ORIGIN,
    'x-forwarded-for': `198.51.100.${ipCounter % 250}`,
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete merged[name];
    else merged[name] = value;
  }
  return new Request(`${ORIGIN}/api/vneid/${route}`, {
    method: 'POST',
    body: new Uint8Array(body),
    headers: merged,
  });
}

const jsonRequest = (
  route: string,
  payload: unknown,
  headers: Record<string, string | null> = {}
) => {
  const body = Buffer.from(JSON.stringify(payload));
  return buildRequest(route, body, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    ...headers,
  });
};

const finalizeRequest = (
  pdf: Buffer,
  ticket: { transactionId: string; clientSecret: string },
  headers: Record<string, string | null> = {}
) =>
  buildRequest('finalize', pdf, {
    'content-type': 'application/pdf',
    'content-length': String(pdf.length),
    'x-vneid-tx': ticket.transactionId,
    authorization: `Bearer ${ticket.clientSecret}`,
    ...headers,
  });

describe('/api/vneid routes', () => {
  let pdf: Buffer;
  let ctx: TestContext;
  let logs: string[];

  beforeAll(async () => {
    pdf = await createSamplePdf();
  });

  beforeEach(() => {
    vi.stubEnv('APP_ORIGIN', ORIGIN);
    vi.stubEnv('TURNSTILE_SECRET', '');
    resetVneidServiceForTests();
    ctx = createTestContext();
    currentDeps = () => ctx.deps;
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
    expect(logs.join('\n')).not.toContain(CITIZEN_PID);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function startedTicket() {
    const response = await sign(await signRequest(pdf));
    expect(response.status).toBe(200);
    return (await response.json()) as { transactionId: string; clientSecret: string };
  }

  it('runs the whole flow: sign, status, finalize', async () => {
    const response = await sign(await signRequest(pdf));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const started = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(started).sort()).toEqual(
      [
        'clientSecret',
        'codeRequired',
        'confirmDeadline',
        'documentName',
        'expiresAt',
        'transactionId',
      ].sort()
    );
    expect(String(started.confirmDeadline)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const ticket = {
      transactionId: String(started.transactionId),
      clientSecret: String(started.clientSecret),
    };
    const auth = { authorization: `Bearer ${ticket.clientSecret}` };

    ctx.csign.complete();
    const statusResponse = await status(
      jsonRequest('status', { transactionId: ticket.transactionId }, auth)
    );
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({ status: 'SIGNED', codeRequired: false });

    const done = await finalize(finalizeRequest(pdf, ticket));
    expect(done.status).toBe(200);
    expect(done.headers.get('content-type')).toBe('application/pdf');
    expect(done.headers.get('content-disposition')).toBe(
      `attachment; filename="kysoqr-vneid-${ticket.transactionId}.pdf"`
    );
    expect(done.headers.get('content-security-policy')).toBe('sandbox');
    const signed = Buffer.from(await done.arrayBuffer());
    expect((await verifyPdfSignatures(signed, ctx.identity.trustStore))[0]!.status).toBe(
      'SIGNED_VALID'
    );
  });

  it('refuses cross-site and malformed sign requests before reading them', async () => {
    const codeOf = async (response: Response) => [
      response.status,
      ((await response.json()) as { error: string }).error,
    ];
    expect(await codeOf(await sign(await signRequest(pdf, {}, { origin: null })))).toEqual([
      403,
      'VNEID_FORBIDDEN_ORIGIN',
    ]);
    expect(
      await codeOf(await sign(await signRequest(pdf, {}, { origin: 'https://evil.example' })))
    ).toEqual([403, 'VNEID_FORBIDDEN_ORIGIN']);
    expect(
      await codeOf(await sign(await signRequest(pdf, {}, { 'content-length': null })))
    ).toEqual([411, 'VNEID_LENGTH_REQUIRED']);
    expect(
      await codeOf(
        await sign(await signRequest(pdf, {}, { 'content-length': String(20 * 1024 * 1024) }))
      )
    ).toEqual([413, 'VNEID_PAYLOAD_TOO_LARGE']);
    expect(await codeOf(await sign(jsonRequest('sign', {})))).toEqual([
      415,
      'VNEID_UNSUPPORTED_MEDIA_TYPE',
    ]);
    expect(await codeOf(await sign(await signRequest(pdf, { citizenPid: '12345' })))).toEqual([
      400,
      'VNEID_INVALID_INPUT',
    ]);
    expect(
      await codeOf(await sign(await signRequest(pdf, { signatureFields: '[{"page":1}]' })))
    ).toEqual([400, 'VNEID_INVALID_INPUT']);
    expect(await codeOf(await sign(await signRequest(pdf, { language: 'fr' })))).toEqual([
      400,
      'VNEID_INVALID_INPUT',
    ]);
    expect(ctx.csign.signRequests).toHaveLength(0);
  });

  it('answers in English when asked, and maps errors to documented codes only', async () => {
    const english = await sign(await signRequest(pdf, { citizenPid: '12345', language: 'en' }));
    expect(((await english.json()) as { message: string }).message).toMatch(/^Invalid input/);

    currentDeps = () => {
      throw new VneidError('VNEID_NOT_CONFIGURED', 'missing env');
    };
    const notConfigured = await sign(await signRequest(pdf));
    expect(notConfigured.status).toBe(503);
    expect(await notConfigured.json()).toEqual({
      error: 'VNEID_NOT_CONFIGURED',
      message: 'Máy chủ chưa được cấu hình để ký bằng VNeID. Vui lòng liên hệ quản trị viên.',
    });

    currentDeps = () => {
      throw new Error('database exploded at /var/lib/kysoqr');
    };
    const unexpected = await sign(await signRequest(pdf));
    expect(unexpected.status).toBe(500);
    const body = (await unexpected.json()) as { error: string; message: string };
    expect(body.error).toBe('VNEID_INTERNAL');
    expect(body.message).not.toContain('/var/lib');
  });

  it('gives the same 404 for an unknown transaction and a wrong secret', async () => {
    const ticket = await startedTicket();
    for (const [payload, secret] of [
      [{ transactionId: ticket.transactionId }, 'A'.repeat(43)],
      [{ transactionId: '00000000-0000-4000-8000-000000000000' }, ticket.clientSecret],
      [{ transactionId: 'nope' }, ticket.clientSecret],
    ] as const) {
      const response = await status(
        jsonRequest('status', payload, { authorization: `Bearer ${secret}` })
      );
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: string }).error).toBe('VNEID_NOT_FOUND');
    }
    const garbage = Buffer.from('{not json');
    const response = await status(
      buildRequest('status', garbage, {
        'content-type': 'application/json',
        'content-length': String(garbage.length),
      })
    );
    expect(response.status).toBe(400);
  });

  it('checks finalize credentials and length before reading the PDF', async () => {
    const ticket = await startedTicket();
    const early = await finalize(finalizeRequest(pdf, ticket));
    expect(early.status).toBe(409);
    expect(((await early.json()) as { error: string }).error).toBe('VNEID_NOT_READY');

    ctx.csign.complete();
    await status(
      jsonRequest(
        'status',
        { transactionId: ticket.transactionId },
        { authorization: `Bearer ${ticket.clientSecret}` }
      )
    );
    const wrongSecret = await finalize(
      finalizeRequest(pdf, { ...ticket, clientSecret: 'B'.repeat(43) })
    );
    expect(wrongSecret.status).toBe(404);
    const wrongLength = await finalize(
      finalizeRequest(Buffer.concat([pdf, Buffer.from('extra')]), ticket)
    );
    expect(wrongLength.status).toBe(409);
    expect(((await wrongLength.json()) as { error: string }).error).toBe('VNEID_DOCUMENT_MISMATCH');
  });

  it('lists certificates without personal data, and signs with the picked one', async () => {
    const listed = await credentials(jsonRequest('credentials', { citizenPid: CITIZEN_PID }));
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    const body = (await listed.json()) as {
      credentials: { credentialId: string; usable: boolean }[];
    };
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]!.usable).toBe(true);
    expect(JSON.stringify(body)).not.toContain('Nguyen Van Test');

    const foreign = await credentials(
      jsonRequest('credentials', { citizenPid: CITIZEN_PID }, { origin: 'https://evil.example' })
    );
    expect(foreign.status).toBe(403);
    expect((await credentials(jsonRequest('credentials', { citizenPid: '12' }))).status).toBe(400);
    const saved = ctx.csign.credentials;
    ctx.csign.credentials = [];
    const none = await credentials(jsonRequest('credentials', { citizenPid: CITIZEN_PID }));
    expect(none.status).toBe(422);
    expect(((await none.json()) as { error: string }).error).toBe('VNEID_NO_CERTIFICATE');
    ctx.csign.credentials = saved;

    const picked = body.credentials[0]!.credentialId;
    const signed = await sign(await signRequest(pdf, { credentialId: picked }));
    expect(signed.status).toBe(200);
    expect(((await signed.json()) as { documentName: string }).documentName).toMatch(/^KysoQR - /);
    expect(ctx.csign.lastRequest.credentialId).toBe(picked);
    const malformed = await sign(await signRequest(pdf, { credentialId: 'not hex!' }));
    expect(malformed.status).toBe(400);
  });

  it('receives CSign webhooks in the spec format', async () => {
    const ticket = await startedTicket();
    const row = ctx.deps.store.get(ticket.transactionId)!;
    const delivery = webhookDelivery(
      {
        id: 'evt_route_1',
        eventName: 'signing.completed',
        data: {
          transactionId: row.csignTransactionId,
          providerTransactionId: row.rscaTransactionId,
          status: 4,
          signatures: [{ documentId: row.documentId, signature: ctx.csign.sign() }],
          errorCode: null,
        },
      },
      undefined,
      ctx.clock.now
    );
    const send = (body: Buffer, signature: string) =>
      webhook(
        new Request(`${ORIGIN}/api/vneid/webhook`, {
          method: 'POST',
          body: new Uint8Array(body),
          headers: {
            'content-type': 'application/json',
            'content-length': String(body.length),
            'abp-webhook-signature': signature,
          },
        })
      );

    const forged = await send(delivery.body, 'HMAC SHA256=' + '0'.repeat(64));
    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({
      error: 'invalid_signature',
      errorDescription: 'Signature verification failed',
    });

    const accepted = await send(delivery.body, delivery.header);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ received: true });
    expect(ctx.deps.store.get(ticket.transactionId)!.status).toBe('SIGNED');

    currentDeps = () => {
      throw new VneidError('VNEID_NOT_CONFIGURED', 'missing env');
    };
    const off = await send(delivery.body, delivery.header);
    expect(off.status).toBe(503);
    expect(((await off.json()) as { error: string }).error).toBe('not_configured');
  });

  it('lists providers, registers a certificate and reports it by CCCD, keeping the form private', async () => {
    const listed = await providers(
      new Request(`${ORIGIN}/api/vneid/providers`, {
        headers: { 'x-forwarded-for': '203.0.113.9' },
      })
    );
    expect(listed.status).toBe(200);
    const { providers: list } = (await listed.json()) as {
      providers: { provider: string; packs: { code: string; free: boolean }[] }[];
    };
    expect(list[0]!.packs.map((pack) => [pack.code, pack.free])).toEqual([
      ['VNEID-FREE-12M', true],
      ['CMC-24M', false],
    ]);

    const form = {
      fullName: 'Nguyễn Văn Bê',
      birthDate: '1990-12-23',
      gender: 'Nam',
      phone: '0987654321',
      email: 'be@example.test',
    };
    const payload = {
      citizenPid: CITIZEN_PID,
      provider: 'HUD-CMC-CA',
      servicePackCode: 'VNEID-FREE-12M',
      userInfo: form,
    };
    const foreign = await register(
      jsonRequest('registrations', payload, { origin: 'https://evil.example' })
    );
    expect(foreign.status).toBe(403);
    const bad = await register(
      jsonRequest('registrations', { ...payload, userInfo: { ...form, phone: '1' } })
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('VNEID_REGISTRATION_INVALID');
    const noLength = await register(
      jsonRequest('registrations', payload, { 'content-length': null })
    );
    expect(noLength.status).toBe(411);

    const created = await register(jsonRequest('registrations', payload));
    expect(created.status).toBe(201);
    const createdBody = JSON.stringify(await created.json());
    expect(createdBody).toContain('"status":"PENDING"');
    expect(ctx.csign.registerRequests[0]!.userInfo).toMatchObject({ fullName: 'Nguyễn Văn Bê' });
    const again = await register(jsonRequest('registrations', payload));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('VNEID_REGISTRATION_PENDING');
    // Registrations are deleted after 30 minutes; the per-CCCD daily limit is
    // kept in memory (3 tries: the bad form, the accepted one, the refused one).
    const limited = await register(jsonRequest('registrations', payload));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^[0-9]+$/);
    expect(((await limited.json()) as { error: string }).error).toBe('VNEID_REGISTRATION_LIMITED');

    // A reload: the page only has the CCCD again.
    ctx.csign.registration = {
      statusCode: 0,
      serialNumber: '54011D98F5344A6939E0E19199053623',
      errorCode: undefined,
      resultCode: undefined,
    };
    ctx.clock.advance(6_000);
    const found = await registration(
      jsonRequest('registrations/status', { citizenPid: CITIZEN_PID })
    );
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({
      registration: { status: 'COMPLETED', serialNumber: '54011D98F5344A6939E0E19199053623' },
    });
    const nobody = await registration(
      jsonRequest('registrations/status', { citizenPid: '079123456789' })
    );
    expect(await nobody.json()).toEqual({ registration: null });

    const everything = [createdBody, logs.join('\n')].join('\n');
    for (const secret of ['Nguyễn Văn Bê', '0987654321', 'be@example.test', '1990']) {
      expect(everything).not.toContain(secret);
    }
  });
});
