import { createHash, X509Certificate } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { MAX_CHAIN_CERTS } from '../pdfSign/limits';
import type { TrustStore } from '../trustStore/TrustStore';
import type { CsignCredential } from './csignClient';

/**
 * Which certificate CSign may sign with, decided BEFORE sign-hash is called --
 * a refusal here sends nothing to the citizen's phone.
 *
 * CSign's word is not taken for any of it: the certificate must name the very
 * CCCD the user typed (subject UID `CCCD:<number>`), carry an RSA key we can
 * build a PAdES signature for, be valid now, match the credentialID CSign will
 * sign with, and chain -- link by link, signatures checked -- up to its root.
 *
 * Whether that root is one of the national roots KysoQR's trust store holds
 * is reported (`rootTrusted`), not enforced: the CSign UAT environment uses a
 * test root no public store carries, and the chain itself is what proves the
 * key belongs to the certificate. A signature under an unknown root still
 * shows as "root not trusted" in /verify and in Adobe.
 *
 * Failures carry only non-personal detail (CA names, fingerprints, counts):
 * the subject of a VNeID certificate holds the citizen's name and number.
 */

export type CertPolicyFailure =
  | 'NO_CREDENTIAL'
  /** CSign lists it, but not as active (or its key is not enabled). */
  | 'CERT_NOT_ACTIVE'
  | 'CERT_MALFORMED'
  | 'SERIAL_MISMATCH'
  /** The certificate does not belong to the CCCD that was entered. */
  | 'UID_MISMATCH'
  | 'KEY_UNSUPPORTED'
  | 'KEY_USAGE'
  | 'NOT_YET_VALID'
  | 'EXPIRED'
  | 'CHAIN_BROKEN'
  | 'CHAIN_TOO_LONG';

export type CertPolicyDetail = Record<string, string | number | boolean | undefined>;

export class CertPolicyError extends Error {
  readonly failure: CertPolicyFailure;
  readonly detail: CertPolicyDetail;

  constructor(failure: CertPolicyFailure, detail: CertPolicyDetail = {}) {
    super(`certificate rejected: ${failure}`);
    this.name = 'CertPolicyError';
    this.failure = failure;
    this.detail = detail;
  }
}

export interface AcceptedCredential {
  credentialId: string;
  certificateDer: Buffer;
  /** Issuing CA certificates to embed in the CMS, issuer first, root excluded. */
  chainDer: Buffer[];
  /** Undefined when the chain does not end at a self-signed root we can find. */
  rootDer: Buffer | undefined;
  /** Lowercase hex, when the root is known. */
  rootSha256: string | undefined;
  rootCommonName: string | undefined;
  /** The root is one of the national roots in KysoQR's trust store. */
  rootTrusted: boolean;
  /** Every CA certificate CSign listed links up (issued and signed the one below). */
  chainVerified: boolean;
  /** The first link check that failed, when `chainVerified` is false. */
  chainIssue: ChainCheck | undefined;
  /** CA data about that link, for the server log. */
  chainIssueDetail: CertPolicyDetail | undefined;
  issuerCommonName: string;
  validFrom: Date;
  validTo: Date;
  /** Subject CN, for the visible signature. Personal: never log it. */
  signerName: string;
}

export interface CertPolicyOptions {
  now: Date;
  trustStore: TrustStore;
}

const OID_UID = '0.9.2342.19200300.100.1.1';
const OID_COMMON_NAME = '2.5.4.3';
const OID_KEY_USAGE = '2.5.29.15';
/** keyUsage bits 0 (digitalSignature) and 1 (nonRepudiation), first byte. */
const SIGNING_KEY_USAGE_BITS = 0xc0;
const MIN_RSA_BITS = 2048;
const MAX_RSA_BITS = 4096;
/** Leaf + CAs embedded in the CMS + root. */
const MAX_LISTED_CERTS = MAX_CHAIN_CERTS + 2;

/** When several credentials fail, the error shown is the most useful one. */
const FAILURE_PRIORITY: CertPolicyFailure[] = [
  'UID_MISMATCH',
  'EXPIRED',
  'NOT_YET_VALID',
  'CERT_NOT_ACTIVE',
  'KEY_UNSUPPORTED',
  'KEY_USAGE',
  'SERIAL_MISMATCH',
  'CHAIN_BROKEN',
  'CHAIN_TOO_LONG',
  'CERT_MALFORMED',
];

const sha256Hex = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** Serial / credentialID compared as hex, ignoring case, separators and leading zeros. */
const normalizeSerial = (value: string) =>
  value
    .replace(/[^0-9a-fA-F]/g, '')
    .replace(/^0+/, '')
    .toUpperCase();

function decodeCertificate(base64: string): { der: Buffer; x509: X509Certificate } {
  const compact = base64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw new CertPolicyError('CERT_MALFORMED');
  const der = Buffer.from(compact, 'base64');
  try {
    return { der, x509: new X509Certificate(der) };
  } catch {
    throw new CertPolicyError('CERT_MALFORMED');
  }
}

/** pkijs reads every key type (node-forge throws on non-RSA keys). */
function parseWithPkijs(der: Buffer): pkijs.Certificate {
  try {
    return pkijs.Certificate.fromBER(toArrayBuffer(der));
  } catch {
    throw new CertPolicyError('CERT_MALFORMED');
  }
}

function attributeValue(name: pkijs.RelativeDistinguishedNames, oid: string): string | undefined {
  const found = name.typesAndValues.find((entry) => entry.type === oid);
  const value = (found?.value as { valueBlock?: { value?: unknown } } | undefined)?.valueBlock
    ?.value;
  return typeof value === 'string' ? value : undefined;
}

function allowsSigning(certificate: pkijs.Certificate): boolean {
  const extension = certificate.extensions?.find((entry) => entry.extnID === OID_KEY_USAGE);
  // No keyUsage extension means no restriction (RFC 5280 section 4.2.1.3).
  if (!extension) return true;
  const parsed = asn1js.fromBER(extension.extnValue.valueBlock.valueHexView);
  if (!(parsed.result instanceof asn1js.BitString)) return false;
  const firstByte = parsed.result.valueBlock.valueHexView[0] ?? 0;
  return (firstByte & SIGNING_KEY_USAGE_BITS) !== 0;
}

function isValidAt(certificate: X509Certificate, now: Date): 'ok' | 'NOT_YET_VALID' | 'EXPIRED' {
  if (now < new Date(certificate.validFrom)) return 'NOT_YET_VALID';
  if (now > new Date(certificate.validTo)) return 'EXPIRED';
  return 'ok';
}

const issuedBy = (child: X509Certificate, issuer: X509Certificate) =>
  child.checkIssued(issuer) && child.verify(issuer.publicKey);

const isSelfSigned = (certificate: X509Certificate) => issuedBy(certificate, certificate);

/** Which link check refused a chain (see `evaluate`). */
export type ChainCheck =
  'issuer-not-ca' | 'name-mismatch' | 'signature-mismatch' | 'ca-expired' | 'ca-not-yet-valid';

/** CN of a node:crypto X509Certificate subject/issuer string ("C=VN\nCN=..."). */
const dnCommonName = (dn: string) =>
  dn
    .split('\n')
    .find((line) => line.startsWith('CN='))
    ?.slice(3);

const commonNameOf = (der: Buffer) =>
  attributeValue(parseWithPkijs(der).subject, OID_COMMON_NAME) ?? '(no CN)';

function evaluate(
  credential: CsignCredential,
  citizenPid: string,
  options: CertPolicyOptions
): AcceptedCredential {
  if (credential.certStatus !== undefined && credential.certStatus !== 1) {
    throw new CertPolicyError('CERT_NOT_ACTIVE', { certStatus: credential.certStatus });
  }
  if (credential.keyStatus !== undefined && credential.keyStatus.toLowerCase() !== 'enabled') {
    throw new CertPolicyError('CERT_NOT_ACTIVE', { keyStatus: credential.keyStatus });
  }
  if (credential.certificates.length === 0) throw new CertPolicyError('CERT_MALFORMED');
  if (credential.certificates.length > MAX_LISTED_CERTS) {
    throw new CertPolicyError('CHAIN_TOO_LONG', { listed: credential.certificates.length });
  }

  const certs = credential.certificates.map(decodeCertificate);
  const leaf = certs[0]!;
  if (leaf.x509.ca) throw new CertPolicyError('CERT_MALFORMED', { reason: 'leaf is a CA' });

  if (normalizeSerial(leaf.x509.serialNumber) !== normalizeSerial(credential.credentialId)) {
    throw new CertPolicyError('SERIAL_MISMATCH');
  }

  const key = leaf.x509.publicKey;
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (
    key.asymmetricKeyType !== 'rsa' ||
    bits < MIN_RSA_BITS ||
    bits > MAX_RSA_BITS ||
    key.asymmetricKeyDetails?.publicExponent !== 65537n
  ) {
    throw new CertPolicyError('KEY_UNSUPPORTED', {
      keyType: key.asymmetricKeyType,
      bits: bits || undefined,
    });
  }

  const validity = isValidAt(leaf.x509, options.now);
  if (validity !== 'ok') throw new CertPolicyError(validity);

  const parsedLeaf = parseWithPkijs(leaf.der);
  if (attributeValue(parsedLeaf.subject, OID_UID) !== `CCCD:${citizenPid}`) {
    throw new CertPolicyError('UID_MISMATCH');
  }
  if (!allowsSigning(parsedLeaf)) throw new CertPolicyError('KEY_USAGE');

  // Every listed certificate must be issued (and signed) by the next one.
  // Each link: is the next listed certificate the CA that issued and signed
  // this one? CSign's own answer says nothing about the chain, so a broken
  // link is reported, not refused (the UAT gateway sends production CA
  // certificates with test-issued ones). The chain is cut at the first broken
  // link: what CSign sent past it is not this certificate's chain, so none of
  // it is embedded, and the root is unknown.
  const breakAt = (() => {
    for (let index = 0; index + 1 < certs.length; index += 1) {
      const child = certs[index]!.x509;
      const issuer = certs[index + 1]!.x509;
      const found = (check: ChainCheck) => ({
        index,
        check,
        detail: {
          link: index,
          check,
          issuerCn: dnCommonName(issuer.subject),
          issuerSerial: issuer.serialNumber,
          issuerValidFrom: new Date(issuer.validFrom).toISOString(),
          issuerValidTo: new Date(issuer.validTo).toISOString(),
          childIssuerCn: dnCommonName(child.issuer),
        },
      });
      if (!issuer.ca) return found('issuer-not-ca');
      if (!child.checkIssued(issuer)) return found('name-mismatch');
      if (!child.verify(issuer.publicKey)) return found('signature-mismatch');
      const validity = isValidAt(issuer, options.now);
      if (validity === 'EXPIRED') return found('ca-expired');
      if (validity === 'NOT_YET_VALID') return found('ca-not-yet-valid');
    }
    return undefined;
  })();

  // The root: the last listed certificate when it is self-signed, otherwise a
  // root from the trust store that issued it, otherwise unknown.
  const last = certs[certs.length - 1]!;
  let root: { der: Buffer; x509: X509Certificate } | undefined;
  let embedded: Buffer[];
  if (breakAt) {
    root = undefined;
    // The CA certificates that do link up, up to the break (none at link 0).
    embedded = certs.slice(1, breakAt.index + 1).map((cert) => cert.der);
  } else if (certs.length > 1 && isSelfSigned(last.x509)) {
    root = last;
    embedded = certs.slice(1, -1).map((cert) => cert.der);
  } else {
    root = options.trustStore
      .getTrustedRootPems()
      .map((pem) => {
        try {
          const x509 = new X509Certificate(pem);
          return { der: x509.raw, x509 };
        } catch {
          return undefined;
        }
      })
      .find((candidate) => candidate !== undefined && issuedBy(last.x509, candidate.x509));
    embedded = certs.slice(1).map((cert) => cert.der);
  }
  if (embedded.length > MAX_CHAIN_CERTS) {
    throw new CertPolicyError('CHAIN_TOO_LONG', { embedded: embedded.length });
  }

  return {
    credentialId: credential.credentialId,
    certificateDer: leaf.der,
    chainDer: embedded,
    rootDer: root?.der,
    rootSha256: root ? sha256Hex(root.der) : undefined,
    rootCommonName: root ? commonNameOf(root.der) : undefined,
    rootTrusted: root ? options.trustStore.isTrustedRoot(root.x509.toString()) : false,
    chainVerified: breakAt === undefined,
    chainIssue: breakAt?.check,
    chainIssueDetail: breakAt?.detail,
    // The CA named in the certificate itself (not whatever CSign attached).
    issuerCommonName: dnCommonName(leaf.x509.issuer) ?? '(no CN)',
    validFrom: new Date(leaf.x509.validFrom),
    validTo: new Date(leaf.x509.validTo),
    signerName: attributeValue(parsedLeaf.subject, OID_COMMON_NAME) ?? '',
  };
}

export interface CredentialEvaluation {
  credential: CsignCredential;
  accepted: AcceptedCredential | undefined;
  failure: CertPolicyError | undefined;
}

/** Every credential of the citizen with its verdict (for the certificate list). */
export function evaluateCredentials(
  credentials: CsignCredential[],
  citizenPid: string,
  options: CertPolicyOptions
): CredentialEvaluation[] {
  return credentials.map((credential) => {
    try {
      return {
        credential,
        accepted: evaluate(credential, citizenPid, options),
        failure: undefined,
      };
    } catch (error) {
      if (!(error instanceof CertPolicyError)) throw error;
      return { credential, accepted: undefined, failure: error };
    }
  });
}

const sameCredentialId = (a: string, b: string) => normalizeSerial(a) === normalizeSerial(b);

/** Issuing CA, validity and key size of a credential's certificate -- for one
 * that failed the policy. Nothing about the holder. */
export function summarizeCredential(credential: CsignCredential): {
  issuerCn: string | undefined;
  validFrom: string | undefined;
  validTo: string | undefined;
  keyBits: number | undefined;
} {
  try {
    const { x509 } = decodeCertificate(credential.certificates[0] ?? '');
    return {
      issuerCn: x509.issuer
        .split('\n')
        .find((line) => line.startsWith('CN='))
        ?.slice(3),
      validFrom: new Date(x509.validFrom).toISOString(),
      validTo: new Date(x509.validTo).toISOString(),
      keyBits: x509.publicKey.asymmetricKeyDetails?.modulusLength,
    };
  } catch {
    return {
      issuerCn: /CN=([^,]+)/.exec(credential.issuerDn ?? '')?.[1]?.trim(),
      validFrom: undefined,
      validTo: undefined,
      keyBits: undefined,
    };
  }
}

/**
 * The credential to sign with: the acceptable one that stays valid longest.
 * Throws CertPolicyError (the most useful failure) when none is acceptable.
 */
export function chooseCredential(
  credentials: CsignCredential[],
  citizenPid: string,
  options: CertPolicyOptions,
  /** The credential the user picked; it must be listed AND pass the policy. */
  selectedId?: string
): AcceptedCredential {
  if (credentials.length === 0) throw new CertPolicyError('NO_CREDENTIAL');
  if (selectedId !== undefined) {
    const selected = credentials.find((credential) =>
      sameCredentialId(credential.credentialId, selectedId)
    );
    if (!selected) {
      throw new CertPolicyError('NO_CREDENTIAL', { reason: 'selected credential is not listed' });
    }
    return evaluate(selected, citizenPid, options);
  }
  const evaluations = evaluateCredentials(credentials, citizenPid, options);
  const accepted = evaluations.flatMap((entry) => (entry.accepted ? [entry.accepted] : []));
  const failures = evaluations.flatMap((entry) => (entry.failure ? [entry.failure] : []));
  if (accepted.length > 0) {
    return accepted.reduce((best, candidate) =>
      candidate.validTo > best.validTo ? candidate : best
    );
  }
  const rank = (failure: CertPolicyError) => FAILURE_PRIORITY.indexOf(failure.failure);
  const worst = failures.reduce((best, candidate) =>
    rank(candidate) < rank(best) ? candidate : best
  );
  throw new CertPolicyError(worst.failure, { ...worst.detail, credentials: credentials.length });
}

/**
 * The trust store for the post-signing self-check: KysoQR's roots plus the
 * root this signature chains to, so a signature under the CSign UAT root is
 * still checked end to end (chain and maths) instead of stopping at "root
 * not trusted".
 */
export function withPinnedRoot(base: TrustStore, rootDer: Buffer | undefined): TrustStore {
  if (!rootDer) return base;
  const rootPem = new X509Certificate(rootDer).toString();
  const rootBody = rootPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return {
    isConfigured: () => true,
    isTrustedRoot: (candidate) =>
      candidate.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '') === rootBody ||
      base.isTrustedRoot(candidate),
    getTrustedRootPems: () => [...base.getTrustedRootPems(), rootPem],
  };
}
