import { constants, createHash, publicDecrypt, type X509Certificate } from 'node:crypto';
import * as asn1js from 'asn1js';
import { rsaModulusBytes, verifyRsaPkcs1Sha256 } from '../pdfSign/rsa';

/**
 * What a signature CSign returned actually signs.
 *
 * The CSign spec says sign-hash takes a "hash" and returns a base64
 * "signature", and nothing about what exactly is signed. KysoQR sends
 * SHA-256(signed attributes) and needs back RSA-PKCS#1-v1.5 over
 * DigestInfo(sha256, that digest) -- the only thing a PAdES CMS can carry.
 * The spec's own examples (a 32-byte digestValue, a 256-byte signature)
 * point that way, but it is checked on every signature anyway:
 *
 *   OK                   exactly what we need;
 *   REHASHED             DigestInfo(sha256, SHA-256(digest))   (signed the digest as data);
 *   HASHED_BASE64_TEXT   DigestInfo(sha256, SHA-256(base64 text of the digest));
 *   NO_DIGESTINFO        the bare 32-byte digest, no DigestInfo around it;
 *   DIGEST_MISMATCH      a SHA-256 DigestInfo over something else;
 *   OTHER_HASH:<oid>     a DigestInfo with another hash algorithm;
 *   UNKNOWN_PAYLOAD      a valid PKCS#1 v1.5 block holding something else;
 *   NOT_PKCS1_V15        no PKCS#1 v1.5 block (wrong key, PSS, garbage);
 *   CMS                  a whole CMS SignedData instead of a raw signature;
 *   UNKNOWN_FORMAT       neither of the size of the key nor a CMS.
 *
 * Only OK is ever used. Any other verdict goes to the server log as one code,
 * so the first real signature tells us how to adapt -- without logging the
 * signature, the certificate or anything personal.
 */

export type SignatureDiagnosis =
  | 'OK'
  | 'REHASHED'
  | 'HASHED_BASE64_TEXT'
  | 'NO_DIGESTINFO'
  | 'DIGEST_MISMATCH'
  | `OTHER_HASH:${string}`
  | 'UNKNOWN_PAYLOAD'
  | 'NOT_PKCS1_V15'
  | 'CMS'
  | 'UNKNOWN_FORMAT';

export interface DiagnoseInput {
  certificate: X509Certificate;
  signature: Buffer;
  /** DER SET of the signed attributes (what the CMS says was signed). */
  signedAttrsDer: Buffer;
  /** The 32 bytes sent to CSign as digestValue: SHA-256(signedAttrsDer). */
  digestSent: Buffer;
}

const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
/** DER prefix of DigestInfo(sha256, <32 bytes>) -- RFC 8017 section 9.2. */
const SHA256_DIGEST_INFO_PREFIX = Buffer.from('3031300d060960864801650304020105000420', 'hex');

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();
const digestInfo = (digest: Buffer) => Buffer.concat([SHA256_DIGEST_INFO_PREFIX, digest]);
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function parseDer(bytes: Buffer): asn1js.AsnType | undefined {
  const parsed = asn1js.fromBER(toArrayBuffer(bytes));
  return parsed.offset === -1 || parsed.offset !== bytes.length ? undefined : parsed.result;
}

function isCmsSignedData(bytes: Buffer): boolean {
  const root = parseDer(bytes);
  if (!(root instanceof asn1js.Sequence)) return false;
  const contentType = root.valueBlock.value[0];
  return (
    contentType instanceof asn1js.ObjectIdentifier && contentType.getValue() === OID_SIGNED_DATA
  );
}

/** DigestInfo ::= SEQUENCE { SEQUENCE { OID, params }, OCTET STRING } */
function readDigestInfo(bytes: Buffer): { oid: string; digest: Buffer } | undefined {
  const root = parseDer(bytes);
  if (!(root instanceof asn1js.Sequence) || root.valueBlock.value.length !== 2) return undefined;
  const [algorithm, digest] = root.valueBlock.value;
  if (!(algorithm instanceof asn1js.Sequence) || !(digest instanceof asn1js.OctetString)) {
    return undefined;
  }
  const oid = algorithm.valueBlock.value[0];
  if (!(oid instanceof asn1js.ObjectIdentifier)) return undefined;
  return { oid: oid.getValue(), digest: Buffer.from(digest.valueBlock.valueHexView) };
}

export function diagnoseSignature(input: DiagnoseInput): SignatureDiagnosis {
  const modulusBytes = rsaModulusBytes(input.certificate);
  if (!modulusBytes || input.signature.length !== modulusBytes) {
    return isCmsSignedData(input.signature) ? 'CMS' : 'UNKNOWN_FORMAT';
  }
  // The real check, through the same verification the CMS assembly uses.
  if (verifyRsaPkcs1Sha256(input.certificate, input.signedAttrsDer, input.signature)) return 'OK';

  let block: Buffer;
  try {
    block = publicDecrypt(
      { key: input.certificate.publicKey, padding: constants.RSA_PKCS1_PADDING },
      input.signature
    );
  } catch {
    return 'NOT_PKCS1_V15';
  }

  if (block.equals(digestInfo(sha256(input.digestSent)))) return 'REHASHED';
  if (block.equals(digestInfo(sha256(input.digestSent.toString('base64'))))) {
    return 'HASHED_BASE64_TEXT';
  }
  if (block.equals(input.digestSent)) return 'NO_DIGESTINFO';
  const info = readDigestInfo(block);
  if (info) return info.oid === OID_SHA256 ? 'DIGEST_MISMATCH' : `OTHER_HASH:${info.oid}`;
  return 'UNKNOWN_PAYLOAD';
}

/** Strict base64 decoding: undefined for anything that is not clean base64. */
export function decodeBase64Strict(value: string): Buffer | undefined {
  const compact = value.replace(/\s+/g, '');
  if (compact.length === 0 || compact.length % 4 !== 0) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return undefined;
  return Buffer.from(compact, 'base64');
}
