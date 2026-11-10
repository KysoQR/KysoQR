import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { fetchWithTimeout, isTimeoutError, readBefore } from '../fetchWithTimeout';
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
 * signature, our nonce, a time close to ours, the token's own signature, and
 * that it was signed by a time-stamping certificate that chains to a public
 * root Node trusts (so someone on the network path to an http TSA cannot slip
 * in a token signed with a key of their own).
 */

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
/** A token whose time is further than this from the server clock is refused. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const SHA256 = '2.16.840.1.101.3.4.2.1';
/** PKIStatus granted (0) and grantedWithMods (1). */
const GRANTED = new Set([0, 1]);
/** id-kp-timeStamping (RFC 3161: the TSA's certificate must carry it). */
const TIME_STAMPING = '1.3.6.1.5.5.7.3.8';
const MAX_CHAIN = 5;

let trustedRoots: X509Certificate[] | undefined;

/** Roots a TSA certificate must chain to: Node's public roots, or `pems` (tests). */
export function setTsaTrustedRootsForTests(pems: readonly string[] | undefined): void {
  trustedRoots = pems?.map((pem) => new X509Certificate(pem));
}

function roots(): X509Certificate[] {
  trustedRoots ??= rootCertificates.map((pem) => new X509Certificate(pem));
  return trustedRoots;
}

/**
 * The token's signing certificate (the one its SignerInfo names) must be a
 * time-stamping certificate, valid at genTime, whose chain -- through the
 * certificates the token carries -- ends at a trusted root. Returns why not.
 */
function untrustedSigner(signedData: pkijs.SignedData, genTime: Date): string | undefined {
  const certificates = (signedData.certificates ?? [])
    .filter((item): item is pkijs.Certificate => item instanceof pkijs.Certificate)
    .map((item) => new X509Certificate(Buffer.from(item.toSchema().toBER(false))));
  const sid = signedData.signerInfos[0]?.sid;
  if (!(sid instanceof pkijs.IssuerAndSerialNumber)) return 'signer not named by serial';
  const serial = Buffer.from(sid.serialNumber.valueBlock.valueHexView).toString('hex');
  const signer = certificates.find(
    (cert) => cert.serialNumber.toLowerCase().replace(/^0+/, '') === serial.replace(/^0+/, '')
  );
  if (!signer) return 'signer certificate not in the token';
  if (!(signer.keyUsage ?? []).includes(TIME_STAMPING)) return 'not a time-stamping certificate';

  const at = genTime.getTime();
  const valid = (cert: X509Certificate) =>
    Date.parse(cert.validFrom) <= at && at <= Date.parse(cert.validTo);
  const trusted = roots();
  let current = signer;
  for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
    if (!valid(current)) return 'a certificate of the chain was not valid at genTime';
    // The certificate itself is a trusted one (a self-signed test TSA, for instance).
    if (trusted.some((root) => root.fingerprint256 === current.fingerprint256)) return undefined;
    const signedBy = (issuer: X509Certificate) =>
      current.checkIssued(issuer) && current.verify(issuer.publicKey);
    const root = trusted.find(signedBy);
    if (root) return undefined;
    const next = certificates.find((cert) => cert !== current && cert.ca && signedBy(cert));
    if (!next) return 'chain does not reach a trusted root';
    current = next;
  }
  return 'chain too long';
}

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

async function readLimited(response: Response, deadline: number): Promise<Buffer> {
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
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await readBefore(reader, deadline);
    } catch (error) {
      throw new TsaError(isTimeoutError(error) ? 'no answer in time' : 'answer could not be read');
    }
    const { done, value } = chunk;
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

  // Body included: a TSA that trickles its answer must not hold finalize.
  const { status, tokenDer } = parseResponse(await readLimited(response, startedAt + TIMEOUT_MS));
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
  const distrust = untrustedSigner(token.signedData, token.genTime);
  if (distrust) throw new TsaError(`token signer is not trusted (${distrust})`);

  console.info('[vneid:tsa] timestamp obtained', {
    tsa: new URL(options.url).host,
    ms: Date.now() - startedAt,
    genTime: token.genTime.toISOString(),
    bytes: tokenDer.length,
  });
  return { tokenDer, genTime: token.genTime };
}

/** Why a token's signer is not trusted (undefined: it is); for checks and tests. */
export function timestampSignerProblem(tokenDer: Buffer): string | undefined {
  const token = readTimestampToken(tokenDer);
  return untrustedSigner(token.signedData, token.genTime);
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
