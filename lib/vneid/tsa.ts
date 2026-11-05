import { createHash, randomBytes } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { fetchWithTimeout, isTimeoutError } from '../fetchWithTimeout';
import { normalizeNonce, readTimestampToken } from '../pdfSign/cms';

/**
 * RFC 3161 timestamps for VNeID signatures (PAdES baseline B-T).
 *
 * The visible signature, /M and the signed attributes are all fixed before the
 * citizen confirms on VNeID, so none of them can carry the time of the
 * confirmation. A timestamp over the signature value can: it is asked for once
 * CSign has returned the signature, and goes into the CMS as an unsigned
 * attribute (lib/pdfSign/cms.ts), which leaves the signature itself untouched.
 * Adobe Reader then shows the timestamp's time as the signing time.
 *
 * Every answer is checked before use: granted status, the imprint of this very
 * signature, our nonce, a time close to ours, and the token's own signature.
 */

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
/** A token whose time is further than this from the server clock is refused. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const SHA256 = '2.16.840.1.101.3.4.2.1';
/** PKIStatus granted (0) and grantedWithMods (1). */
const GRANTED = new Set([0, 1]);

export interface Timestamp {
  /** The TimeStampToken (CMS ContentInfo), exactly as the TSA sent it. */
  tokenDer: Buffer;
  genTime: Date;
}

/** Stamps a signature value; injected into the service so tests need no network. */
export type TimestampSource = (signature: Buffer) => Promise<Timestamp>;

/** Recognized across module copies (see CsignError): the TSA source in the
 * shared deps may come from another copy of this module. */
const TSA_ERROR = Symbol.for('kysoqr.vneid.TsaError');

export class TsaError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && TSA_ERROR in value;
  }

  constructor(message: string) {
    super(message);
    Object.defineProperty(this, TSA_ERROR, { value: true });
    this.name = 'TsaError';
  }
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest();
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** 64-bit positive nonce whose first byte is never zero (so it stays DER-minimal). */
export function newNonce(): Buffer {
  const nonce = randomBytes(8);
  nonce[0] = (nonce[0]! & 0x7f) | 0x40;
  return nonce;
}

/** DER TimeStampReq for SHA-256(signature), asking for the TSA certificate. */
export function buildTimestampRequest(signature: Uint8Array, nonce: Uint8Array): Buffer {
  const request = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: SHA256 }),
      hashedMessage: new asn1js.OctetString({ valueHex: toArrayBuffer(sha256(signature)) }),
    }),
    nonce: new asn1js.Integer({ valueHex: toArrayBuffer(nonce) }),
    certReq: true,
  });
  return Buffer.from(request.toSchema().toBER(false));
}

async function readLimited(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new TsaError(`answer too large (${declared} bytes)`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TsaError(`answer too large (more than ${MAX_RESPONSE_BYTES} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** The PKIStatus and the token's original bytes from a TimeStampResp. */
function parseResponse(der: Buffer): { status: number; tokenDer: Buffer | undefined } {
  const parsed = asn1js.fromBER(toArrayBuffer(der));
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    throw new TsaError('answer is not a TimeStampResp');
  }
  let response: pkijs.TimeStampResp;
  try {
    response = new pkijs.TimeStampResp({ schema: parsed.result });
  } catch {
    throw new TsaError('answer is not a TimeStampResp');
  }
  const tokenNode = parsed.result.valueBlock.value[1];
  return {
    status: response.status.status,
    // The token's signature covers its exact bytes: keep them, never re-encode.
    tokenDer: tokenNode ? Buffer.from(tokenNode.valueBeforeDecodeView) : undefined,
  };
}

export interface RequestTimestampOptions {
  url: string;
  now?: () => number;
  /** Fixed nonce, for tests. */
  nonce?: Buffer;
}

export async function requestTimestamp(
  signature: Buffer,
  options: RequestTimestampOptions
): Promise<Timestamp> {
  const now = options.now ?? Date.now;
  const nonce = options.nonce ?? newNonce();
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetchWithTimeout(
      options.url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/timestamp-query',
          Accept: 'application/timestamp-reply',
        },
        body: new Uint8Array(buildTimestampRequest(signature, nonce)),
        redirect: 'error',
        cache: 'no-store',
      },
      TIMEOUT_MS
    );
  } catch (error) {
    throw new TsaError(isTimeoutError(error) ? 'no answer in time' : 'request failed');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new TsaError(`HTTP ${response.status}`);
  }

  const { status, tokenDer } = parseResponse(await readLimited(response));
  if (!GRANTED.has(status)) throw new TsaError(`request not granted (status ${status})`);
  if (!tokenDer) throw new TsaError('granted without a token');

  let token: ReturnType<typeof readTimestampToken>;
  try {
    token = readTimestampToken(tokenDer);
  } catch {
    throw new TsaError('token could not be read');
  }
  if (token.hashAlgorithm !== SHA256 || !token.imprint.equals(sha256(signature))) {
    throw new TsaError('token stamps something else');
  }
  if (!token.nonce || !token.nonce.equals(normalizeNonce(nonce))) {
    throw new TsaError('token nonce does not match');
  }
  if (Math.abs(token.genTime.getTime() - now()) > MAX_CLOCK_SKEW_MS) {
    throw new TsaError('token time is too far from ours');
  }
  let verified = false;
  try {
    // `data` is what was stamped: pkijs checks the imprint against it too.
    verified = await token.signedData.verify({
      signer: 0,
      checkChain: false,
      data: toArrayBuffer(signature),
    });
  } catch {
    verified = false;
  }
  if (!verified) throw new TsaError('token signature does not verify');

  console.info('[vneid:tsa] timestamp obtained', {
    tsa: new URL(options.url).host,
    ms: Date.now() - startedAt,
    genTime: token.genTime.toISOString(),
    bytes: tokenDer.length,
  });
  return { tokenDer, genTime: token.genTime };
}

/**
 * Asks each TSA in turn and keeps the first timestamp that passes every check,
 * so one TSA being down, slow or answering something unusable does not cost
 * the signature its timestamp. Each attempt is a fresh request (new nonce, its
 * own timeout); when all fail, the error names each TSA and why.
 */
export function timestampFromAny(urls: readonly string[]): TimestampSource {
  if (urls.length === 0) throw new TsaError('no TSA configured');
  return async (signature) => {
    const failures: string[] = [];
    for (const [index, url] of urls.entries()) {
      try {
        return await requestTimestamp(signature, { url });
      } catch (error) {
        const tsa = new URL(url).host;
        const reason = error instanceof TsaError ? error.message : 'error';
        failures.push(`${tsa}: ${reason}`);
        if (index < urls.length - 1) {
          console.warn('[vneid:tsa] TSA failed, trying the next one', { tsa, reason });
        }
      }
    }
    throw new TsaError(failures.join('; '));
  };
}
