import { z } from 'zod';
import { hmacSha256, safeEqual } from './crypto';
import { CsignError } from './csignClient';
import { type ApplyOutcome, applyCsignResult, type CsignResult, type VneidDeps } from './service';

/**
 * CSign webhook receiver (spec section IV), framework-free: the route hands
 * over the raw body and the signature header and sends back what this returns.
 *
 *   - HMAC-SHA256 over the raw body, keyed with the whole webhook secret
 *     (UTF-8), in `abp-webhook-signature: HMAC SHA256=<hex>`; the previous
 *     secret is accepted too while secrets are being rotated;
 *   - the envelope must name our organization and be recent;
 *   - every event id is processed once (CSign redelivers on 5xx);
 *   - signing.* events are matched to a transaction by CSign's transactionId
 *     and cross-checked against the provider transaction id sign-hash returned;
 *   - a signature is stored only once it verifies (applyCsignResult);
 *   - a failure event is confirmed with query-status before it ends anything.
 *
 * Answers follow the spec: 200 {received:true} (also for events deliberately
 * ignored), 4xx/5xx {error, errorDescription}; only 500 makes CSign retry.
 * Payloads are never logged (registration.* ones carry CCCD and certificates).
 */

export const MAX_WEBHOOK_BYTES = 64 * 1024;
const MAX_EVENT_AGE_MS = 30 * 60_000;
const SIGNATURE_HEADER_PATTERN = /^\s*HMAC\s+SHA256=([0-9a-fA-F]{64})\s*$/i;

export interface WebhookResponse {
  status: 200 | 400 | 401 | 500 | 503;
  body: Record<string, unknown>;
}

const received = (): WebhookResponse => ({ status: 200, body: { received: true } });
const refuse = (
  status: WebhookResponse['status'],
  error: string,
  errorDescription: string
): WebhookResponse => ({ status, body: { error, errorDescription } });

export function verifyWebhookSignature(
  rawBody: Uint8Array,
  header: string | null | undefined,
  secrets: string[]
): boolean {
  const match = header ? SIGNATURE_HEADER_PATTERN.exec(header) : null;
  if (!match) return false;
  const presented = Buffer.from(match[1]!, 'hex');
  return secrets.some((secret) =>
    safeEqual(hmacSha256(Buffer.from(secret, 'utf8'), rawBody), presented)
  );
}

const id = z.string().min(1).max(200);
const optionalId = z
  .union([z.string().max(200), z.number().transform(String)])
  .nullish()
  .transform((value) => value ?? undefined);

const envelopeSchema = z.object({
  id,
  eventName: z.string().min(1).max(100),
  timestamp: z.string().min(1).max(64),
  organizationId: id,
  data: z.unknown(),
});

const signingDataSchema = z.object({
  transactionId: id,
  documentNumber: optionalId,
  providerTransactionId: optionalId,
  providerInternalId: optionalId,
  status: z.union([
    z.number().int(),
    z
      .string()
      .regex(/^[0-9]+$/)
      .transform(Number),
  ]),
  signatures: z
    .array(
      z.object({
        documentId: optionalId,
        signature: z
          .string()
          .max(16 * 1024)
          .nullish(),
      })
    )
    .max(20)
    .nullish(),
  errorCode: z.string().max(100).nullish(),
});

type SigningData = z.infer<typeof signingDataSchema>;

function toResult(data: SigningData, signedAt: number | undefined): CsignResult {
  return {
    statusCode: data.status,
    errorCode: data.errorCode ?? undefined,
    signatures: (data.signatures ?? [])
      .filter((entry) => typeof entry.signature === 'string' && entry.signature.length > 0)
      .map((entry) => ({ documentId: entry.documentId, signature: entry.signature! })),
    providerInternalId: data.providerInternalId,
    documentNumber: data.documentNumber,
    signedAt,
  };
}

export async function handleWebhook(
  deps: VneidDeps,
  rawBody: Buffer,
  signatureHeader: string | null
): Promise<WebhookResponse> {
  const webhook = deps.config.webhook;
  if (!webhook) return refuse(503, 'not_configured', 'Webhook receiver is not configured');
  if (rawBody.length > MAX_WEBHOOK_BYTES) {
    return refuse(400, 'payload_too_large', 'Payload exceeds the accepted size');
  }
  if (!verifyWebhookSignature(rawBody, signatureHeader, webhook.secrets)) {
    return refuse(401, 'invalid_signature', 'Signature verification failed');
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return refuse(400, 'invalid_payload', 'Body is not JSON');
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return refuse(400, 'invalid_payload', 'Unexpected event envelope');
  const event = envelope.data;
  if (event.organizationId !== webhook.organizationId) {
    return refuse(400, 'organization_mismatch', 'Event is for another organization');
  }
  const now = deps.now();
  const eventTime = Date.parse(event.timestamp);
  if (!Number.isFinite(eventTime) || Math.abs(now - eventTime) > MAX_EVENT_AGE_MS) {
    return refuse(400, 'stale_event', 'Event timestamp is too far from the current time');
  }

  try {
    if (deps.store.hasWebhookEvent(event.id)) return received();

    const record = (csignTransactionId: string | undefined, outcome: string) =>
      deps.store.recordWebhookEvent(
        { id: event.id, csignTransactionId, name: event.eventName, outcome },
        deps.now()
      );

    if (!event.eventName.startsWith('signing.')) {
      // registration.* and anything new: acknowledged, not processed, not logged.
      record(undefined, 'ignored');
      return received();
    }
    const data = signingDataSchema.safeParse(event.data);
    if (!data.success) return refuse(400, 'invalid_payload', 'Unexpected signing event data');
    const signing = data.data;

    const row = deps.store.getByCsignTransactionId(signing.transactionId);
    if (!row) {
      record(signing.transactionId, 'unknown_transaction');
      return received();
    }
    if (
      row.rscaTransactionId &&
      signing.providerTransactionId !== undefined &&
      signing.providerTransactionId !== row.rscaTransactionId
    ) {
      console.warn('[vneid:webhook] provider transaction id does not match; event ignored', {
        transactionId: row.id,
        event: event.eventName,
      });
      record(signing.transactionId, 'provider_mismatch');
      return received();
    }

    // What to apply: the event itself, or -- for a failure, or a completion
    // without a usable signature -- what query-status says right now.
    let result = toResult(signing, eventTime);
    const completedWithoutSignature =
      event.eventName === 'signing.completed' && result.signatures.length === 0;
    if (event.eventName === 'signing.failed' || completedWithoutSignature) {
      try {
        const confirmed = await deps.csign.queryStatus(signing.transactionId);
        result = {
          ...result,
          statusCode: confirmed.statusCode,
          errorCode: confirmed.errorCode ?? result.errorCode,
          signatures: confirmed.signatures.length > 0 ? confirmed.signatures : result.signatures,
        };
      } catch (error) {
        console.warn('[vneid:webhook] could not confirm the event with query-status', {
          transactionId: row.id,
          reason: error instanceof CsignError ? error.kind : 'error',
        });
      }
    }

    // The event is recorded in the same transaction as the state change it
    // causes: a redelivery racing this one finds the event and does nothing.
    deps.store.transaction(() => {
      if (deps.store.hasWebhookEvent(event.id)) return;
      const fresh = deps.store.get(row.id);
      const outcome: ApplyOutcome = fresh
        ? applyCsignResult(deps, fresh, result, 'webhook')
        : 'unchanged';
      record(signing.transactionId, outcome);
    });
    return received();
  } catch (error) {
    console.error('[vneid:webhook] processing failed', {
      event: event.eventName,
      message: error instanceof Error ? error.message : String(error),
    });
    return refuse(500, 'internal_error', 'Event could not be processed; retry later');
  }
}
