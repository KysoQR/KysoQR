import { createHash } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { PdfSignError } from './errors.ts';
import { MAX_CHAIN_CERTS } from './limits.ts';
import { loadCertificate, rsaModulusBytes, verifyRsaPkcs1Sha256 } from './rsa.ts';

/**
 * Detached CMS SignedData for a PAdES signature (SubFilter
 * ETSI.CAdES.detached, baseline B), built in two steps because the signature
 * itself comes from CSign, minutes later and from another process:
 *
 *   buildSignedAttributes()  ->  digest to send to CSign (sign-hash)
 *   assembleCms()            ->  CMS around the signature CSign returned
 *
 * signedAttrs hold contentType, messageDigest and ESS signing-certificate-v2
 * (the last is what PAdES requires), DER-sorted. The signer signs the DER SET
 * of those attributes; there is no signingTime attribute (PAdES keeps the time
 * in the signature dictionary's /M).
 *
 * An RFC 3161 timestamp over the signature value (baseline B-T) can be added
 * as the unsigned attribute signatureTimeStampToken: it is taken after CSign
 * returns the signature, so it carries the time the signer confirmed, and it
 * changes neither the signed attributes nor the signature.
 *
 * Ported from the USB-token agent (agent/src/pdf/cms.ts), minus the PKCS#11
 * and ECDSA parts.
 */

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  signatureTimeStampToken: '1.2.840.113549.1.9.16.2.14',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
} as const;

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest();
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function parseCertificate(der: Uint8Array): pkijs.Certificate {
  try {
    return pkijs.Certificate.fromBER(toArrayBuffer(der));
  } catch {
    throw new PdfSignError('CMS_INVALID', 'certificate could not be parsed');
  }
}

function attribute(type: string, value: asn1js.AsnType): pkijs.Attribute {
  return new pkijs.Attribute({ type, values: [value] });
}

/** ESSCertIDv2 with the default hash algorithm (SHA-256, so omitted) and
 * issuerSerial pointing at the signer certificate. */
function signingCertificateV2(certificate: pkijs.Certificate, der: Uint8Array): asn1js.Sequence {
  const issuerSerial = new asn1js.Sequence({
    value: [
      // GeneralNames: one directoryName [4] EXPLICIT Name
      new asn1js.Sequence({
        value: [
          new asn1js.Constructed({
            idBlock: { tagClass: 3, tagNumber: 4 },
            value: [certificate.issuer.toSchema()],
          }),
        ],
      }),
      certificate.serialNumber,
    ],
  });
  const essCertIdV2 = new asn1js.Sequence({
    value: [new asn1js.OctetString({ valueHex: toArrayBuffer(sha256(der)) }), issuerSerial],
  });
  return new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIdV2] })] });
}

/** DER requires SET OF members in ascending order of their encodings. */
function sortedForDer(attributes: pkijs.Attribute[]): pkijs.Attribute[] {
  const encoded = attributes.map((attr) => ({
    attr,
    der: Buffer.from(attr.toSchema().toBER(false)),
  }));
  encoded.sort((a, b) => Buffer.compare(a.der, b.der));
  return encoded.map((entry) => entry.attr);
}

/** What gets signed is the DER encoding of the attributes as a SET (tag 0x31),
 * not the [0] IMPLICIT form they take inside SignerInfo. */
function encodeAsSet(attributes: pkijs.Attribute[]): Buffer {
  return Buffer.from(
    new asn1js.Set({ value: attributes.map((attr) => attr.toSchema()) }).toBER(false)
  );
}

export interface SignedAttributes {
  /** DER SET OF Attribute: the exact bytes the signer signs. */
  der: Buffer;
  /** SHA-256(der): the `digestValue` for CSign's sign-hash. */
  digest: Buffer;
}

export function buildSignedAttributes(
  contentDigest: Uint8Array,
  certificateDer: Uint8Array
): SignedAttributes {
  if (contentDigest.length !== 32)
    throw new PdfSignError('CMS_INVALID', 'content digest is not 32 bytes');
  const certificate = parseCertificate(certificateDer);
  const attributes = sortedForDer([
    attribute(OID.contentType, new asn1js.ObjectIdentifier({ value: OID.data })),
    attribute(
      OID.messageDigest,
      new asn1js.OctetString({ valueHex: toArrayBuffer(contentDigest) })
    ),
    attribute(OID.signingCertificateV2, signingCertificateV2(certificate, certificateDer)),
  ]);
  const der = encodeAsSet(attributes);
  return { der, digest: sha256(der) };
}

/** Upper bound for the DER size of the CMS, to size the /Contents placeholder
 * before the signature exists (RSA signature = one modulus; the rest is a
 * generous allowance for attributes, SignerInfo and the ASN.1 wrappers). */
export function estimateCmsSize(
  certificateDer: Uint8Array,
  chainDer: Uint8Array[],
  signatureBytes = 256
): number {
  const certs = chainDer.reduce((sum, der) => sum + der.length, certificateDer.length);
  return certs + signatureBytes + 1024;
}

export interface TimestampTokenInfo {
  /** The token as a parsed CMS SignedData (signer certificate included). */
  signedData: pkijs.SignedData;
  hashAlgorithm: string;
  /** messageImprint.hashedMessage. */
  imprint: Buffer;
  genTime: Date;
  /** Big-endian, leading zero bytes removed; undefined when absent. */
  nonce: Buffer | undefined;
}

const withoutLeadingZeros = (bytes: Buffer): Buffer => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  return bytes.subarray(start);
};

/** Reads an RFC 3161 TimeStampToken (ContentInfo holding a SignedData whose
 * content is a TSTInfo). Throws CMS_INVALID when it is anything else. */
export function readTimestampToken(tokenDer: Uint8Array): TimestampTokenInfo {
  try {
    const parsed = asn1js.fromBER(toArrayBuffer(tokenDer));
    if (parsed.offset === -1) throw new Error('not BER');
    const contentInfo = new pkijs.ContentInfo({ schema: parsed.result });
    if (contentInfo.contentType !== OID.signedData) throw new Error('not SignedData');
    const signedData = new pkijs.SignedData({ schema: contentInfo.content });
    const encap = signedData.encapContentInfo;
    if (encap.eContentType !== OID.tstInfo || !encap.eContent) throw new Error('not a TSTInfo');
    const tstInfo = pkijs.TSTInfo.fromBER(encap.eContent.getValue());
    return {
      signedData,
      hashAlgorithm: tstInfo.messageImprint.hashAlgorithm.algorithmId,
      imprint: Buffer.from(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView),
      genTime: tstInfo.genTime,
      nonce: tstInfo.nonce
        ? withoutLeadingZeros(Buffer.from(tstInfo.nonce.valueBlock.valueHexView))
        : undefined,
    };
  } catch (error) {
    throw new PdfSignError(
      'CMS_INVALID',
      `timestamp token could not be read (${error instanceof Error ? error.message : 'error'})`
    );
  }
}

/** The nonce as it is compared with a TSTInfo's (no leading zero bytes). */
export const normalizeNonce = (nonce: Uint8Array): Buffer =>
  withoutLeadingZeros(Buffer.from(nonce));

/** A timestamp token must stamp exactly this signature value (SHA-256). */
function assertTokenStamps(tokenDer: Uint8Array, signature: Uint8Array): void {
  const token = readTimestampToken(tokenDer);
  if (token.hashAlgorithm !== OID.sha256 || !token.imprint.equals(sha256(signature))) {
    throw new PdfSignError('CMS_INVALID', 'timestamp token is not for this signature');
  }
}

export interface AssembleCmsInput {
  /** The exact `der` from buildSignedAttributes. */
  signedAttrsDer: Uint8Array;
  certificateDer: Uint8Array;
  /** Issuing CA certificates to embed (issuer first); never the root. */
  chainDer: Uint8Array[];
  /** Raw RSA signature from CSign. */
  signature: Uint8Array;
  /** RFC 3161 TimeStampToken over `signature`, embedded unsigned as is. */
  timestampToken?: Uint8Array | undefined;
}

/**
 * CMS around a signature CSign returned. Fails closed: the signature must
 * verify (RSA PKCS#1 v1.5 / SHA-256) against the signer certificate and the
 * stored signed attributes, or no CMS is produced.
 */
export function assembleCms(input: AssembleCmsInput): Buffer {
  if (input.chainDer.length > MAX_CHAIN_CERTS) {
    throw new PdfSignError('CMS_INVALID', `certificate chain longer than ${MAX_CHAIN_CERTS}`);
  }
  const x509 = loadCertificate(input.certificateDer);
  const modulusBytes = rsaModulusBytes(x509);
  if (!modulusBytes) throw new PdfSignError('CMS_INVALID', 'signer key is not RSA');
  if (!verifyRsaPkcs1Sha256(x509, input.signedAttrsDer, input.signature)) {
    throw new PdfSignError(
      'SIGNATURE_INVALID',
      'signature does not match the signer certificate and signed attributes'
    );
  }

  const certificate = parseCertificate(input.certificateDer);

  // Rebuild the attributes from the stored DER, in their stored (DER-sorted)
  // order, and insist the SET re-encodes to exactly the bytes that were signed.
  const parsed = asn1js.fromBER(toArrayBuffer(input.signedAttrsDer));
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Set)) {
    throw new PdfSignError('CMS_INVALID', 'signed attributes are not a DER SET');
  }
  const signedAttributes = parsed.result.valueBlock.value.map(
    (node) => new pkijs.Attribute({ schema: node })
  );
  if (!encodeAsSet(signedAttributes).equals(Buffer.from(input.signedAttrsDer))) {
    throw new PdfSignError('CMS_INVALID', 'signed attributes do not re-encode to the signed bytes');
  }

  if (input.timestampToken) assertTokenStamps(input.timestampToken, input.signature);
  // A DER token re-encodes to its own bytes; the check after encoding makes
  // sure of it, since the token's signature covers those exact bytes.
  const unsigned = input.timestampToken
    ? {
        unsignedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 1,
          attributes: [
            new pkijs.Attribute({
              type: OID.signatureTimeStampToken,
              values: [asn1js.fromBER(toArrayBuffer(input.timestampToken)).result],
            }),
          ],
        }),
      }
    : {};

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({
      issuer: certificate.issuer,
      serialNumber: certificate.serialNumber,
    }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: signedAttributes }),
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({
      algorithmId: OID.rsaEncryption,
      algorithmParams: new asn1js.Null(),
    }),
    signature: new asn1js.OctetString({ valueHex: toArrayBuffer(input.signature) }),
    ...unsigned,
  });

  const signedData = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 })],
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    certificates: [certificate, ...input.chainDer.map(parseCertificate)],
    signerInfos: [signerInfo],
  });
  const contentInfo = new pkijs.ContentInfo({
    contentType: OID.signedData,
    content: signedData.toSchema(true),
  });
  const cms = Buffer.from(contentInfo.toSchema().toBER(false));
  if (input.timestampToken && cms.indexOf(Buffer.from(input.timestampToken)) === -1) {
    throw new PdfSignError('CMS_INVALID', 'timestamp token was not embedded byte for byte');
  }
  return cms;
}
