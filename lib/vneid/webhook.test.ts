import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOX, createSamplePdf } from '../pdfSign/testHelpers';
import { verifyPdfSignatures } from '../verification/verifyPdfSignatures';
import { CsignError } from './csignClient';
import { finalizeSigning, getStatus, resetVneidServiceForTests, startSigning } from './service';
import {
  CITIZEN_PID,
  createTestContext,
  type TestContext,
  WEBHOOK_SECRET,
  WEBHOOK_SECRET_PREVIOUS,
  webhookDelivery,
} from './testKit';
import { handleWebhook, verifyWebhookSignature } from './webhook';

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest();

describe('verifyWebhookSignature', () => {
  it('checks HMAC-SHA256 of the raw body in the spec header format', () => {
    // Spec sample: the header carries lowercase hex after "HMAC SHA256=".
    const { body, header } = webhookDelivery(
      { id: 'evt', eventName: 'signing.created', data: {} },
      's3cret'
    );
    expect(verifyWebhookSignature(body, header, ['s3cret'])).toBe(true);
    const upperHex = header.replace(/=([0-9a-f]+)$/, (_, hex: string) => `=${hex.toUpperCase()}`);
    expect(verifyWebhookSignature(body, upperHex, ['s3cret'])).toBe(true);
    expect(verifyWebhookSignature(body, header, ['other', 's3cret'])).toBe(true);
    expect(verifyWebhookSignature(body, header, ['other'])).toBe(false);
    expect(
      verifyWebhookSignature(Buffer.concat([body, Buffer.from(' ')]), header, ['s3cret'])
    ).toBe(false);
    for (const bad of [null, '', 'HMAC SHA256=', 'sha256=abcd', header.replace('HMAC ', '')]) {
      expect(verifyWebhookSignature(body, bad, ['s3cret'])).toBe(false);
    }
  });
});

describe('handleWebhook', () => {
  let pdf: Buffer;
  let ctx: TestContext;
  let ticket: { transactionId: string; clientSecret: string };
  let csignTransactionId: string;
  let logs: string[];

  beforeAll(async () => {
    pdf = await createSamplePdf();
  });

  beforeEach(async () => {
    resetVneidServiceForTests();
    logs = [];
    for (const level of ['error', 'warn', 'log', 'info'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(
          args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
        );
      });
    }
    ctx = createTestContext();
    const started = await startSigning(ctx.deps, {
      pdf,
      fields: [BOX],
      citizenPid: CITIZEN_PID,
      language: 'vi',
    });
    ticket = { transactionId: started.transactionId, clientSecret: started.clientSecret };
    csignTransactionId = ctx.deps.store.get(started.transactionId)!.csignTransactionId!;
  });

  afterEach(() => {
    expect(logs.join('\n')).not.toContain(CITIZEN_PID);
    vi.restoreAllMocks();
  });

  const signingData = (overrides: Record<string, unknown> = {}) => ({
    transactionId: csignTransactionId,
    documentNumber: 'DN-0001',
    providerTransactionId: ctx.deps.store.get(ticket.transactionId)!.rscaTransactionId,
    providerInternalId: '7c8fcedc-4f2e-4bcf-94a9-b6667b66958d',
    status: 4,
    statusDescription: 'Ký thành công',
    signatures: [{ documentId: ctx.csign.lastRequest.documentId, signature: ctx.csign.sign() }],
    errorCode: null,
    ...overrides,
  });

  const deliver = (
    event: Partial<{ id: string; eventName: string; timestamp: string; organizationId: string }> & {
      data?: unknown;
    },
    secret?: string
  ) => {
    const { body, header } = webhookDelivery(
      {
        id: event.id ?? 'evt_1',
        eventName: event.eventName ?? 'signing.completed',
        data: event.data ?? signingData(),
        ...(event.timestamp ? { timestamp: event.timestamp } : {}),
        ...(event.organizationId ? { organizationId: event.organizationId } : {}),
      },
      secret,
      ctx.clock.now
    );
    return handleWebhook(ctx.deps, body, header);
  };

  const status = async () => (await getStatus(ctx.deps, ticket)).status;

  it('stores a verified signature from signing.completed, and the file then finalizes', async () => {
    expect(await deliver({})).toEqual({ status: 200, body: { received: true } });
    const row = ctx.deps.store.get(ticket.transactionId)!;
    expect(row).toMatchObject({
      status: 'SIGNED',
      signatureSource: 'webhook',
      documentNumber: 'DN-0001',
      providerInternalId: '7c8fcedc-4f2e-4bcf-94a9-b6667b66958d',
    });
    expect(ctx.csign.statusQueries).toHaveLength(0);
    const signed = await finalizeSigning(ctx.deps, { ...ticket, original: pdf });
    expect((await verifyPdfSignatures(signed, ctx.identity.trustStore))[0]!.status).toBe(
      'SIGNED_VALID'
    );
  });

  it('accepts the previous secret while secrets rotate, refuses anything else', async () => {
    expect((await deliver({}, 'whsec_wrong')).status).toBe(401);
    expect(await status()).toBe('PENDING');
    expect((await deliver({}, WEBHOOK_SECRET_PREVIOUS)).status).toBe(200);
    expect(ctx.deps.store.get(ticket.transactionId)!.status).toBe('SIGNED');
  });

  it('refuses another organization, stale events and malformed bodies', async () => {
    expect((await deliver({ organizationId: 'someone-else' })).body).toMatchObject({
      error: 'organization_mismatch',
    });
    expect(
      (await deliver({ timestamp: new Date(ctx.clock.now - 31 * 60_000).toISOString() })).body
    ).toMatchObject({ error: 'stale_event' });
    expect((await deliver({ data: { transactionId: csignTransactionId } })).status).toBe(400);
    const garbage = Buffer.from('not json');
    const { header } = webhookDelivery({ id: 'x', eventName: 'x', data: {} });
    expect((await handleWebhook(ctx.deps, garbage, header)).status).toBe(401);
    expect(ctx.deps.store.get(ticket.transactionId)!.status).toBe('PENDING');
  });

  it('processes a redelivered event once', async () => {
    const wrong = signingData({
      signatures: [{ documentId: ctx.csign.lastRequest.documentId, signature: 'AAAA' }],
    });
    expect((await deliver({ id: 'evt_dup', data: wrong })).status).toBe(200);
    expect(ctx.deps.store.get(ticket.transactionId)!.status).toBe('FAILED');
    // Same id again (CSign retry): acknowledged, not processed.
    expect((await deliver({ id: 'evt_dup' })).status).toBe(200);
    expect(ctx.deps.store.get(ticket.transactionId)!.status).toBe('FAILED');
  });

  it('acknowledges registration events and unknown transactions without acting', async () => {
    const registration = await deliver({
      eventName: 'registration.completed',
      data: { citizenPid: CITIZEN_PID, certificateData: 'MIIB' },
    });
    expect(registration.status).toBe(200);
    expect(ctx.deps.store.hasWebhookEvent('evt_1')).toBe(true);
    expect(
      (await deliver({ id: 'evt_2', data: signingData({ transactionId: 'unknown-tx' }) })).status
    ).toBe(200);
    expect(await status()).toBe('PENDING');
  });

  it('ignores an event whose provider transaction id does not match', async () => {
    expect((await deliver({ data: signingData({ providerTransactionId: '999' }) })).status).toBe(
      200
    );
    expect(ctx.deps.store.get(ticket.transactionId)!.status).toBe('PENDING');
  });

  it('fails the request on a signature over something else, with the diagnosis in the log', async () => {
    const rehashed = ctx.csign.sign((digest) => sha256(digest));
    await deliver({
      data: signingData({
        signatures: [{ documentId: ctx.csign.lastRequest.documentId, signature: rehashed }],
      }),
    });
    expect(ctx.deps.store.get(ticket.transactionId)).toMatchObject({
      status: 'FAILED',
      errorCode: 'DIAG_REHASHED',
    });
    expect(logs.some((line) => line.includes('VNEID_SIGNATURE_DIAGNOSIS=REHASHED'))).toBe(true);
  });

  it('confirms a failure event with query-status before ending the request', async () => {
    ctx.csign.status = {
      statusCode: 5,
      resultCode: undefined,
      errorCode: 'errorcode4004',
      signatures: [],
    };
    await deliver({
      eventName: 'signing.failed',
      data: signingData({ status: 0, signatures: null, errorCode: 'errorcode4004' }),
    });
    expect(ctx.csign.statusQueries).toEqual([csignTransactionId]);
    expect(await getStatus(ctx.deps, ticket)).toMatchObject({
      status: 'REJECTED',
      reason: 'REFUSED',
    });
  });

  it('confirms a status 0/5 whatever the event is called, and asks CSign to retry when it cannot', async () => {
    ctx.csign.queryError = new CsignError('UPSTREAM', '/api/signing/query-status', 'down');
    const answer = await deliver({
      eventName: 'signing.created',
      data: signingData({ status: 5, signatures: null, errorCode: 'errorcode4004' }),
    });
    expect(answer.status).toBe(500);
    expect(ctx.csign.statusQueries).toEqual([csignTransactionId]);
    expect(ctx.deps.store.get(ticket.transactionId)!.status).toBe('PENDING');

    // The retry, once query-status answers: what CSign says wins.
    ctx.csign.queryError = undefined;
    ctx.csign.complete();
    await deliver({
      eventName: 'signing.created',
      data: signingData({ status: 5, signatures: null, errorCode: 'errorcode4004' }),
    });
    expect(ctx.deps.store.get(ticket.transactionId)!.status).toBe('SIGNED');
  });

  it('trusts query-status over a failure event that CSign itself contradicts', async () => {
    ctx.csign.complete();
    await deliver({
      eventName: 'signing.failed',
      data: signingData({ status: 0, signatures: null, errorCode: 'errorcode4005' }),
    });
    expect(ctx.deps.store.get(ticket.transactionId)!.status).toBe('SIGNED');
  });

  it('fetches the signature when signing.completed carries none', async () => {
    ctx.csign.complete();
    await deliver({ data: signingData({ signatures: [] }) });
    expect(ctx.deps.store.get(ticket.transactionId)!.status).toBe('SIGNED');
  });

  it('marks progress from signing.created and answers 503 when not configured', async () => {
    await deliver({
      eventName: 'signing.created',
      data: signingData({ status: 3, signatures: null }),
    });
    expect(ctx.deps.store.get(ticket.transactionId)!.status).toBe('WAITING_USER');
    ctx.deps.config = { ...ctx.deps.config, webhook: undefined };
    expect((await deliver({ id: 'evt_9' })).status).toBe(503);
  });

  it('logs every delivery in one line: outcome or refusal, never the payload', async () => {
    const signature = ctx.csign.sign();
    await deliver({});
    await deliver({});
    await deliver({ id: 'evt_2' }, 'whsec_not_the_one');
    await deliver({ id: 'evt_3', organizationId: 'org-someone-else' });
    const text = logs.join('\n');
    expect(text).toContain('[vneid:webhook] signing.completed -> signed');
    expect(text).toContain('"eventId":"evt_1"');
    expect(text).toContain(`"csignTransactionId":"${csignTransactionId}"`);
    expect(text).toContain('[vneid:webhook] signing.completed -> duplicate');
    expect(text).toContain('[vneid:webhook] refused 401 invalid_signature');
    expect(text).toContain('[vneid:webhook] refused 400 organization_mismatch');
    expect(text).not.toContain(signature);
    expect(text).not.toContain(WEBHOOK_SECRET);
  });

  describe('with VNEID_QUERY_STATUS=off', () => {
    beforeEach(() => {
      ctx.deps.config = { ...ctx.deps.config, queryStatus: false };
    });

    it('never asks CSign: only the webhook moves the request on', async () => {
      // CSign has the signature, but nobody asks it.
      ctx.csign.complete();
      for (let i = 0; i < 3; i += 1) {
        ctx.clock.advance(6_000);
        expect(await status()).toBe('PENDING');
      }
      expect(ctx.csign.statusQueries).toHaveLength(0);
      expect((await deliver({})).status).toBe(200);
      expect(await status()).toBe('SIGNED');
    });

    it('applies a failure event as delivered, without confirming it', async () => {
      await deliver({
        eventName: 'signing.failed',
        data: signingData({ status: 5, errorCode: 'errorcode4004', signatures: null }),
      });
      expect(ctx.csign.statusQueries).toHaveLength(0);
      expect(await status()).toBe('REJECTED');
    });
  });
});
