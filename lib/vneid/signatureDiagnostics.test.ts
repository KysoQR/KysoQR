import { constants, createHash, privateEncrypt, randomBytes, X509Certificate } from 'node:crypto';
import * as asn1js from 'asn1js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SoftIdentity } from '../pdfSign/testHelpers';
import { decodeBase64Strict, diagnoseSignature } from './signatureDiagnostics';
import { vneidIdentity } from './testKit';

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();
const SHA1_DIGEST_INFO_PREFIX = Buffer.from('3021300906052b0e03021a05000414', 'hex');

describe('diagnoseSignature', () => {
  let identity: SoftIdentity;
  let certificate: X509Certificate;
  const signedAttrsDer = Buffer.from('3100', 'hex');
  const digestSent = sha256(signedAttrsDer);

  beforeAll(() => {
    identity = vneidIdentity();
    certificate = new X509Certificate(identity.certificateDer);
  });

  const diagnose = (signature: Buffer) =>
    diagnoseSignature({ certificate, signature, signedAttrsDer, digestSent });
  const rawSign = (block: Buffer) =>
    privateEncrypt({ key: identity.privateKey, padding: constants.RSA_PKCS1_PADDING }, block);

  it('accepts exactly a PKCS#1 v1.5 signature over DigestInfo(sha256, digest sent)', () => {
    expect(diagnose(identity.remoteSign(digestSent))).toBe('OK');
  });

  it('recognizes the plausible ways a gateway could sign something else', () => {
    expect(diagnose(identity.remoteSign(sha256(digestSent)))).toBe('REHASHED');
    expect(diagnose(identity.remoteSign(sha256(digestSent.toString('base64'))))).toBe(
      'HASHED_BASE64_TEXT'
    );
    expect(diagnose(rawSign(digestSent))).toBe('NO_DIGESTINFO');
    expect(diagnose(identity.remoteSign(randomBytes(32)))).toBe('DIGEST_MISMATCH');
    expect(diagnose(rawSign(Buffer.concat([SHA1_DIGEST_INFO_PREFIX, randomBytes(20)])))).toBe(
      'OTHER_HASH:1.3.14.3.2.26'
    );
    expect(diagnose(rawSign(randomBytes(40)))).toBe('UNKNOWN_PAYLOAD');
  });

  it('tells a wrong key / garbage from a CMS and from a wrong size', () => {
    const otherKeySignature = vneidIdentity().remoteSign(digestSent);
    expect(diagnose(otherKeySignature)).toBe('NOT_PKCS1_V15');

    const cms = Buffer.from(
      new asn1js.Sequence({
        value: [
          new asn1js.ObjectIdentifier({ value: '1.2.840.113549.1.7.2' }),
          new asn1js.Constructed({
            idBlock: { tagClass: 3, tagNumber: 0 },
            value: [new asn1js.Sequence({ value: [new asn1js.Integer({ value: 1 })] })],
          }),
        ],
      }).toBER()
    );
    expect(diagnose(cms)).toBe('CMS');
    expect(diagnose(randomBytes(100))).toBe('UNKNOWN_FORMAT');
  });
});

describe('decodeBase64Strict', () => {
  it('decodes clean base64 only', () => {
    expect(decodeBase64Strict('AQID')).toEqual(Buffer.from([1, 2, 3]));
    expect(decodeBase64Strict(' AQ\nID ')).toEqual(Buffer.from([1, 2, 3]));
    for (const bad of ['', 'AQI', 'AQ-_', 'AQ==AQ==', 'A*ID']) {
      expect(decodeBase64Strict(bad)).toBeUndefined();
    }
  });
});
