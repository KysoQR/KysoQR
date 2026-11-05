import {
  constants,
  createHash,
  generateKeyPairSync,
  privateEncrypt,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import * as asn1js from 'asn1js';
import forge from 'node-forge';
import { degrees, PDFDocument, type PDFPage } from 'pdf-lib';
import * as pkijs from 'pkijs';
import type { TrustStore } from '../trustStore/TrustStore';
import { finalizePdf } from './finalize.ts';
import { type PrepareInput, preparePdf } from './prepare.ts';

/**
 * Test-only fixtures: a software certificate chain, a "remote signer" that
 * behaves like CSign (it is handed only the 32-byte digest and returns a raw
 * RSA signature), and small sample PDFs. Never imported by app code.
 */

/** DER prefix of DigestInfo(sha256, <32 bytes>) -- RFC 8017 section 9.2. */
const SHA256_DIGEST_INFO_PREFIX = Buffer.from('3031300d060960864801650304020105000420', 'hex');

export interface SoftIdentity {
  /** Signer certificate (leaf), DER. */
  certificateDer: Buffer;
  /** CA certificates to embed after the leaf, issuer first, root excluded. */
  chainDer: Buffer[];
  rootPem: string;
  trustStore: TrustStore;
  privateKey: KeyObject;
  /** What a remote signer does with the digest it is given. */
  remoteSign: (digest: Buffer) => Buffer;
  commonName: string;
}

interface Issued {
  cert: forge.pki.Certificate;
  der: Buffer;
  keyPem: string;
  key: KeyObject;
}

const pemBody = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');

function newKeyPair(modulusLength = 2048) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength });
  return {
    key: privateKey,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

function issue(options: {
  commonName: string;
  /** Extra subject attribute `UID` (VNeID certificates carry CCCD:<number>). */
  uid?: string;
  issuer?: Issued;
  isCa: boolean;
  /** Overrides, to build expired / not-yet-valid certificates. */
  notBefore?: Date;
  notAfter?: Date;
  keyBits?: number;
}): Issued {
  const keys = newKeyPair(options.keyBits);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(keys.publicPem);
  cert.serialNumber = `01${randomBytes(8).toString('hex')}`;
  cert.validity.notBefore = options.notBefore ?? new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = options.notAfter ?? new Date(Date.now() + 365 * 86_400_000);
  const subject: forge.pki.CertificateField[] = [{ name: 'commonName', value: options.commonName }];
  if (options.uid) subject.push({ type: '0.9.2342.19200300.100.1.1', value: options.uid });
  cert.setSubject(subject);
  cert.setIssuer(options.issuer ? options.issuer.cert.subject.attributes : subject);
  cert.setExtensions([
    { name: 'basicConstraints', cA: options.isCa, critical: true },
    options.isCa
      ? { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }
      : { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, critical: true },
  ]);
  const signer = options.issuer
    ? forge.pki.privateKeyFromPem(options.issuer.keyPem)
    : forge.pki.privateKeyFromPem(keys.privatePem);
  cert.sign(signer, forge.md.sha256.create());
  const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  return { cert, der, keyPem: keys.privatePem, key: keys.key };
}

/** root -> [intermediate] -> leaf. `levels: 1` makes the leaf self-signed. */
export function createSoftIdentity(
  options: {
    commonName?: string;
    uid?: string;
    levels?: 1 | 2 | 3;
    leaf?: { notBefore?: Date; notAfter?: Date; keyBits?: number };
  } = {}
): SoftIdentity {
  const commonName = options.commonName ?? 'Nguyen Van A';
  const levels = options.levels ?? 2;
  const leafOptions = { ...(options.leaf ?? {}) };
  if (levels === 1) {
    const leaf = issue({
      commonName,
      ...(options.uid ? { uid: options.uid } : {}),
      isCa: false,
      ...leafOptions,
    });
    return build(leaf, leaf, [], commonName);
  }
  const root = issue({ commonName: 'KysoQR Test Root CA', isCa: true });
  let parent = root;
  const chain: Buffer[] = [];
  if (levels === 3) {
    parent = issue({ commonName: 'KysoQR Test Intermediate CA', isCa: true, issuer: parent });
    chain.unshift(parent.der);
  }
  const issuing = issue({ commonName: 'KysoQR Test Issuing CA', isCa: true, issuer: parent });
  chain.unshift(issuing.der);
  const leaf = issue({
    commonName,
    ...(options.uid ? { uid: options.uid } : {}),
    isCa: false,
    issuer: issuing,
    ...leafOptions,
  });
  return build(leaf, root, chain, commonName);
}

function build(leaf: Issued, root: Issued, chainDer: Buffer[], commonName: string): SoftIdentity {
  const rootPem = forge.pki.certificateToPem(root.cert);
  return {
    certificateDer: leaf.der,
    chainDer,
    rootPem,
    commonName,
    privateKey: leaf.key,
    trustStore: {
      isConfigured: () => true,
      isTrustedRoot: (candidate) => pemBody(candidate) === pemBody(rootPem),
      getTrustedRootPems: () => [rootPem],
    },
    remoteSign: (digest) => {
      if (digest.length !== 32)
        throw new Error('a remote signer is handed exactly a SHA-256 digest');
      return privateEncrypt(
        { key: leaf.key, padding: constants.RSA_PKCS1_PADDING },
        Buffer.concat([SHA256_DIGEST_INFO_PREFIX, digest])
      );
    },
  };
}

// ---- sample PDFs ------------------------------------------------------------------

export interface SamplePage {
  size?: [number, number];
  /** Page /Rotate. */
  rotate?: 0 | 90 | 180 | 270;
  /** [x, y, width, height] as pdf-lib's setCropBox takes it. */
  cropBox?: [number, number, number, number];
  text?: string;
}

/** A small PDF; `objectStreams: true` gives the xref-stream flavour. */
export async function createSamplePdf(
  options: { objectStreams?: boolean; pages?: SamplePage[] } = {}
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const pages = options.pages ?? [
    { size: [595, 842], text: 'Trang 1' },
    { size: [842, 595], text: 'Page 2 landscape' },
  ];
  pages.forEach((spec, index) => {
    const page: PDFPage = doc.addPage(spec.size ?? [595, 842]);
    page.drawText(spec.text ?? `Trang ${index + 1}`, { x: 50, y: 500, size: 18 });
    if (spec.cropBox) page.setCropBox(...spec.cropBox);
    if (spec.rotate) page.setRotation(degrees(spec.rotate));
  });
  return Buffer.from(await doc.save({ useObjectStreams: options.objectStreams ?? false }));
}

// ---- hand-built PDFs (hostile and odd inputs) --------------------------------------

export interface RawObject {
  number: number;
  generation?: number;
  /** Everything between `N G obj` and `endobj`; binary data as latin1. */
  body: string;
}

/**
 * A PDF written by hand with a classic xref table whose offsets are right, so
 * tests can put exactly the structure they want into it. Strings are latin1:
 * one character is one byte.
 */
export function buildClassicPdf(options: {
  objects: RawObject[];
  /** Extra trailer entries, e.g. `/Encrypt 9 0 R`. */
  trailer?: string;
  root?: number;
  header?: string;
  /** Replaces the whole trailer + startxref tail (for broken files). */
  rawTail?: (xrefOffset: number) => string;
}): Buffer {
  let out = options.header ?? '%PDF-1.7\n';
  const placed = new Map<number, { offset: number; generation: number }>();
  for (const object of options.objects) {
    placed.set(object.number, { offset: out.length, generation: object.generation ?? 0 });
    out += `${object.number} ${object.generation ?? 0} obj\n${object.body}\nendobj\n`;
  }
  const size = Math.max(...options.objects.map((object) => object.number)) + 1;
  const xrefAt = out.length;
  out += `xref\n0 ${size}\n`;
  for (let n = 0; n < size; n += 1) {
    const entry = placed.get(n);
    out += entry
      ? `${String(entry.offset).padStart(10, '0')} ${String(entry.generation).padStart(5, '0')} n \n`
      : '0000000000 65535 f \n';
  }
  out += options.rawTail
    ? options.rawTail(xrefAt)
    : `trailer\n<< /Size ${size} /Root ${options.root ?? 1} 0 R ${options.trailer ?? ''} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Catalog, page tree and one page; `extra` objects and entries are merged in. */
export function minimalDocument(
  extra: {
    catalog?: string;
    page?: string;
    objects?: RawObject[];
    trailer?: string;
    mediaBox?: string;
  } = {}
): Buffer {
  return buildClassicPdf({
    objects: [
      { number: 1, body: `<< /Type /Catalog /Pages 2 0 R ${extra.catalog ?? ''} >>` },
      { number: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        number: 3,
        body: `<< /Type /Page /Parent 2 0 R /MediaBox ${extra.mediaBox ?? '[0 0 595 842]'} ${extra.page ?? ''} >>`,
      },
      ...(extra.objects ?? []),
    ],
    ...(extra.trailer ? { trailer: extra.trailer } : {}),
  });
}

/** A signature dictionary shell (no real CMS) carrying the given /Reference entries. */
export function signatureShell(references: string): string {
  return (
    '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached ' +
    `/ByteRange [0 0 0 0] /Contents <00> /Reference [ ${references} ] >>`
  );
}

/** A UI-convention signature box. */
export const BOX = { page: 1, xRatio: 0.55, yRatio: 0.8, widthRatio: 0.38, heightRatio: 0.1 };

export const APPEARANCE = {
  name: 'Nguyen Van A',
  details: ['Ky boi: Nguyen Van A', 'Ky qua VNeID', 'Ngay ky: 03/11/2026 10:15:21 +07:00'],
};

export type PrepareOverrides = Partial<Omit<PrepareInput, 'pdf' | 'certificateDer' | 'chainDer'>>;

/** The whole two-phase flow with a software signer that is handed only the digest, as CSign is. */
export async function signWithIdentity(
  pdf: Buffer,
  identity: SoftIdentity,
  overrides: PrepareOverrides = {}
) {
  const prepared = await preparePdf({
    pdf,
    fields: [BOX],
    appearance: APPEARANCE,
    signingTime: new Date(),
    certificateDer: identity.certificateDer,
    chainDer: identity.chainDer,
    ...overrides,
  });
  const signature = identity.remoteSign(prepared.digestToSign);
  const signed = await finalizePdf({
    original: pdf,
    ...prepared,
    certificateDer: identity.certificateDer,
    chainDer: identity.chainDer,
    signature,
  });
  return { prepared, signature, signed };
}

// ---- a timestamp authority (RFC 3161) ---------------------------------------------------

const TSA_OID = {
  sha256: '2.16.840.1.101.3.4.2.1',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  policy: '1.3.6.1.4.1.99999.1',
} as const;

const arrayBufferOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function derSequence(parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  let length: Buffer;
  if (body.length < 0x80) {
    length = Buffer.from([body.length]);
  } else {
    const hex = body.length.toString(16);
    const bytes = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
    length = Buffer.concat([Buffer.from([0x80 | bytes.length]), bytes]);
  }
  return Buffer.concat([Buffer.from([0x30]), length, body]);
}

export interface TestTsaAnswer {
  /** PKIStatus; anything but 0/1 is sent without a token. */
  status?: number;
  genTime?: Date;
  /** Stamp this imprint instead of the one asked for. */
  imprint?: Buffer;
  /** Answer with this nonce; null leaves it out. */
  nonce?: Buffer | null;
  /** Flip the last byte of the token's signature. */
  tamper?: boolean;
}

export interface TestTsa {
  identity: SoftIdentity;
  /** TimeStampResp DER for a TimeStampReq DER. */
  respond(requestDer: Uint8Array, answer?: TestTsaAnswer): Promise<Buffer>;
  /** A bare TimeStampToken over SHA-256(signature). */
  token(signature: Uint8Array, answer?: TestTsaAnswer): Promise<Buffer>;
}

/** A TSA signing real RFC 3161 tokens with a software key. */
export function createTestTsa(): TestTsa {
  const identity = createSoftIdentity({ commonName: 'KysoQR Test TSA' });
  let serial = 1;

  async function buildToken(
    imprint: Buffer,
    nonce: Buffer | undefined,
    answer: TestTsaAnswer
  ): Promise<Buffer> {
    const tstInfo = new pkijs.TSTInfo({
      version: 1,
      policy: TSA_OID.policy,
      messageImprint: new pkijs.MessageImprint({
        hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: TSA_OID.sha256 }),
        hashedMessage: new asn1js.OctetString({
          valueHex: arrayBufferOf(answer.imprint ?? imprint),
        }),
      }),
      serialNumber: new asn1js.Integer({ value: serial++ }),
      genTime: answer.genTime ?? new Date(),
      ...(nonce ? { nonce: new asn1js.Integer({ valueHex: arrayBufferOf(nonce) }) } : {}),
    });
    const certificate = pkijs.Certificate.fromBER(arrayBufferOf(identity.certificateDer));
    const signedData = new pkijs.SignedData({
      version: 3,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({
        eContentType: TSA_OID.tstInfo,
        eContent: new asn1js.OctetString({ valueHex: tstInfo.toSchema().toBER(false) }),
      }),
      signerInfos: [
        new pkijs.SignerInfo({
          version: 1,
          sid: new pkijs.IssuerAndSerialNumber({
            issuer: certificate.issuer,
            serialNumber: certificate.serialNumber,
          }),
        }),
      ],
      certificates: [certificate],
    });
    // pkijs turns eContent into a constructed (BER) OCTET STRING; TSAs send DER.
    signedData.encapContentInfo.eContent = new asn1js.OctetString({
      valueHex: tstInfo.toSchema().toBER(false),
    });
    const key = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      identity.privateKey.export({ type: 'pkcs8', format: 'der' }),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
    await signedData.sign(key, 0, 'SHA-256');
    const token = Buffer.from(
      new pkijs.ContentInfo({ contentType: TSA_OID.signedData, content: signedData.toSchema(true) })
        .toSchema()
        .toBER(false)
    );
    if (answer.tamper) token[token.length - 1] = token[token.length - 1]! ^ 0x01;
    return token;
  }

  return {
    identity,
    async respond(requestDer, answer = {}) {
      const request = pkijs.TimeStampReq.fromBER(arrayBufferOf(requestDer));
      const status = answer.status ?? 0;
      const statusInfo = new pkijs.PKIStatusInfo({ status });
      if (status !== 0 && status !== 1) {
        return Buffer.from(new pkijs.TimeStampResp({ status: statusInfo }).toSchema().toBER(false));
      }
      const asked = request.nonce ? Buffer.from(request.nonce.valueBlock.valueHexView) : undefined;
      const token = await buildToken(
        Buffer.from(request.messageImprint.hashedMessage.valueBlock.valueHexView),
        answer.nonce === null ? undefined : (answer.nonce ?? asked),
        answer
      );
      // The token goes in as raw bytes, the way a TSA sends it.
      return derSequence([Buffer.from(statusInfo.toSchema().toBER(false)), token]);
    },
    async token(signature, answer = {}) {
      const imprint = createHash('sha256').update(signature).digest();
      return buildToken(imprint, randomBytes(8), answer);
    },
  };
}
