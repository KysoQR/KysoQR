import { createHash, randomBytes } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { beforeAll, describe, expect, it } from 'vitest';
import { assembleCms, buildSignedAttributes, estimateCmsSize, readTimestampToken } from './cms.ts';
import { MAX_CHAIN_CERTS } from './limits.ts';
import { createSoftIdentity, createTestTsa, type SoftIdentity } from './testHelpers.ts';

const digest = (label: string) => createHash('sha256').update(label).digest();
const rejects = (run: () => unknown, code: string) => {
  try {
    run();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected ${code}`);
};

describe('signed attributes', () => {
  let identity: SoftIdentity;
  beforeAll(() => {
    identity = createSoftIdentity({ levels: 2 });
  });

  it('are deterministic for the same digest and certificate', () => {
    const a = buildSignedAttributes(digest('doc'), identity.certificateDer);
    const b = buildSignedAttributes(digest('doc'), identity.certificateDer);
    expect(a.der.equals(b.der)).toBe(true);
    expect(a.digest.equals(createHash('sha256').update(a.der).digest())).toBe(true);
    expect(buildSignedAttributes(digest('other'), identity.certificateDer).der.equals(a.der)).toBe(
      false
    );
  });

  it('are a DER SET (tag 0x31) of three attributes in ascending order', () => {
    const { der } = buildSignedAttributes(digest('doc'), identity.certificateDer);
    expect(der[0]).toBe(0x31);
    // Each attribute is a SEQUENCE (0x30); the OIDs they start with ascend:
    // contentType 1.2.840.113549.1.9.3 < messageDigest ...9.4 < signingCertificateV2 ...9.16.2.47.
    const oids = ['2a864886f70d010903', '2a864886f70d010904', '2a864886f70d010910022f'];
    const hex = der.toString('hex');
    const positions = oids.map((oid) => hex.indexOf(oid));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
  });

  it('refuse a digest that is not 32 bytes and a certificate that is not a certificate', () => {
    rejects(() => buildSignedAttributes(randomBytes(20), identity.certificateDer), 'CMS_INVALID');
    rejects(
      () => buildSignedAttributes(digest('doc'), Buffer.from('not a certificate')),
      'CMS_INVALID'
    );
  });
});

describe('assembleCms', () => {
  let identity: SoftIdentity;
  beforeAll(() => {
    identity = createSoftIdentity({ levels: 3 });
  });

  const attrs = () => buildSignedAttributes(digest('doc'), identity.certificateDer);
  const assemble = (over: Partial<Parameters<typeof assembleCms>[0]> = {}) => {
    const built = attrs();
    return assembleCms({
      signedAttrsDer: built.der,
      certificateDer: identity.certificateDer,
      chainDer: identity.chainDer,
      signature: identity.remoteSign(built.digest),
      ...over,
    });
  };

  it('builds a CMS ContentInfo around a valid signature, and fits the size estimate', () => {
    const cms = assemble();
    expect(cms[0]).toBe(0x30);
    expect(cms.length).toBeLessThanOrEqual(
      estimateCmsSize(identity.certificateDer, identity.chainDer)
    );
    for (const levels of [1, 2, 3] as const) {
      const other = createSoftIdentity({ levels });
      const built = buildSignedAttributes(digest('x'), other.certificateDer);
      const built2 = assembleCms({
        signedAttrsDer: built.der,
        certificateDer: other.certificateDer,
        chainDer: other.chainDer,
        signature: other.remoteSign(built.digest),
      });
      expect(built2.length).toBeLessThanOrEqual(
        estimateCmsSize(other.certificateDer, other.chainDer)
      );
    }
  });

  it('refuses a signature that is not RSA PKCS#1 v1.5 over these attributes', () => {
    rejects(() => assemble({ signature: randomBytes(256) }), 'SIGNATURE_INVALID');
    rejects(() => assemble({ signature: randomBytes(255) }), 'SIGNATURE_INVALID');
    rejects(() => assemble({ signature: Buffer.alloc(0) }), 'SIGNATURE_INVALID');
    // Signed by somebody else.
    const stranger = createSoftIdentity();
    rejects(
      () => assemble({ signature: stranger.remoteSign(attrs().digest) }),
      'SIGNATURE_INVALID'
    );
    // A valid signature, but over another digest.
    rejects(
      () => assemble({ signature: identity.remoteSign(digest('something else')) }),
      'SIGNATURE_INVALID'
    );
    // The digest signed raw (no DigestInfo) is what a mis-configured signer would return.
    rejects(
      () => assemble({ signature: Buffer.from(identity.remoteSign(attrs().digest)).fill(0, 0, 8) }),
      'SIGNATURE_INVALID'
    );
  });

  it('refuses attributes that are not a DER SET', () => {
    const junk = Buffer.from('this is not asn.1 at all');
    rejects(
      () =>
        assemble({
          signedAttrsDer: junk,
          signature: identity.remoteSign(createHash('sha256').update(junk).digest()),
        }),
      'CMS_INVALID'
    );
  });

  it('refuses a chain longer than the limit', () => {
    const extra = Array.from({ length: MAX_CHAIN_CERTS + 1 }, () => identity.chainDer[0]!);
    rejects(() => assemble({ chainDer: extra }), 'CMS_INVALID');
  });

  it('embeds a timestamp token over the signature as an unsigned attribute, byte for byte', async () => {
    const built = attrs();
    const signature = identity.remoteSign(built.digest);
    const tsa = createTestTsa();
    const token = await tsa.token(signature);
    const plain = assemble({ signature });
    const stamped = assemble({ signature, timestampToken: token });
    expect(stamped.indexOf(token)).toBeGreaterThan(0);

    const signedData = new pkijs.SignedData({
      schema: new pkijs.ContentInfo({
        schema: asn1js.fromBER(new Uint8Array(stamped)).result,
      }).content,
    });
    const signer = signedData.signerInfos[0]!;
    expect(signer.unsignedAttrs?.attributes.map((attr) => attr.type)).toEqual([
      '1.2.840.113549.1.9.16.2.14',
    ]);
    // Signed attributes and signature are those of the CMS without a token.
    const plainSigner = new pkijs.SignedData({
      schema: new pkijs.ContentInfo({ schema: asn1js.fromBER(new Uint8Array(plain)).result })
        .content,
    }).signerInfos[0]!;
    expect(Buffer.from(signer.signature.valueBlock.valueHexView)).toEqual(signature);
    expect(Buffer.from(signer.signedAttrs!.toSchema().toBER(false))).toEqual(
      Buffer.from(plainSigner.signedAttrs!.toSchema().toBER(false))
    );
    expect(readTimestampToken(token).imprint).toEqual(
      createHash('sha256').update(signature).digest()
    );
  });

  it('refuses a timestamp token that stamps another signature, or is not a token', async () => {
    const tsa = createTestTsa();
    const other = await tsa.token(randomBytes(256));
    rejects(() => assemble({ timestampToken: other }), 'CMS_INVALID');
    rejects(() => assemble({ timestampToken: Buffer.from('not a token') }), 'CMS_INVALID');
  });
});
