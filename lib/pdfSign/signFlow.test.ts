import { createHash } from 'node:crypto';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyPdfSignatures } from '../verification/verifyPdfSignatures';
import { assertAppendedUpdateIsExact } from './incremental.ts';
import { loadCertificate, verifyRsaPkcs1Sha256 } from './rsa.ts';
import {
  BOX,
  createSamplePdf,
  createSoftIdentity,
  type SoftIdentity,
  signWithIdentity,
} from './testHelpers.ts';

const signOnce = signWithIdentity;

const statuses = async (pdf: Buffer, identity: SoftIdentity) =>
  (await verifyPdfSignatures(pdf, identity.trustStore)).map((result) => result.status);

describe('prepare -> remote signature -> finalize', () => {
  let identity: SoftIdentity;
  beforeAll(() => {
    identity = createSoftIdentity({ levels: 2, uid: 'CCCD:012345678901' });
  });

  for (const objectStreams of [false, true]) {
    it(`produces a signature KysoQR verifies (objectStreams=${objectStreams})`, async () => {
      const original = await createSamplePdf({ objectStreams });
      const { prepared, signed } = await signOnce(original, identity);

      expect(prepared.analysis.xrefKind).toBe(objectStreams ? 'stream' : 'table');
      // Incremental: the original is untouched at the front.
      expect(signed.subarray(0, original.length).equals(original)).toBe(true);
      assertAppendedUpdateIsExact(
        signed.subarray(original.length),
        original.length,
        prepared.analysis.xrefKind,
        prepared.analysis.prevStartXref
      );

      const results = await verifyPdfSignatures(signed, identity.trustStore);
      expect(results.map((result) => result.status)).toEqual(['SIGNED_VALID']);
      expect(results[0]!.contentIntact).toBe(true);

      const reloaded = await PDFDocument.load(signed);
      expect(reloaded.getPageCount()).toBe(2);
      const acroForm = reloaded.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
      expect(acroForm.lookup(PDFName.of('SigFlags'))?.toString()).toBe('3');
      expect(acroForm.lookup(PDFName.of('Fields'), PDFArray).size()).toBe(1);
    });
  }

  it('hands the remote signer a 32-byte digest that is the SHA-256 of the signed attributes', async () => {
    const { prepared } = await signOnce(await createSamplePdf(), identity);
    expect(prepared.digestToSign).toHaveLength(32);
    expect(
      prepared.digestToSign.equals(createHash('sha256').update(prepared.signedAttrsDer).digest())
    ).toBe(true);
    // And a signature over DigestInfo(sha256, digest) is a PKCS#1 v1.5 signature of the attributes.
    const signature = identity.remoteSign(prepared.digestToSign);
    expect(
      verifyRsaPkcs1Sha256(
        loadCertificate(identity.certificateDer),
        prepared.signedAttrsDer,
        signature
      )
    ).toBe(true);
  });

  it('embeds the intermediate certificates so no chain has to be fetched', async () => {
    for (const levels of [2, 3] as const) {
      const chained = createSoftIdentity({ levels });
      expect(chained.chainDer).toHaveLength(levels - 1);
      const { signed } = await signOnce(await createSamplePdf(), chained);
      expect(await statuses(signed, chained)).toEqual(['SIGNED_VALID']);
    }
  });

  it('keeps every earlier signature valid when signing again, three times in a row', async () => {
    for (const objectStreams of [false, true]) {
      let pdf = await createSamplePdf({ objectStreams });
      const baseTime = Date.now();
      for (let round = 1; round <= 3; round += 1) {
        const before = pdf;
        const { signed, prepared } = await signOnce(pdf, identity, {
          fields: [{ ...BOX, page: round === 2 ? 2 : 1, yRatio: 0.1 + round * 0.2 }],
          signingTime: new Date(baseTime + round * 1000),
        });
        expect(prepared.analysis.signatureCount).toBe(round - 1);
        expect(signed.subarray(0, before.length).equals(before)).toBe(true);
        pdf = signed;
        expect(await statuses(pdf, identity)).toEqual(Array(round).fill('SIGNED_VALID'));
      }
      const doc = await PDFDocument.load(pdf);
      const fields = doc.catalog
        .lookup(PDFName.of('AcroForm'), PDFDict)
        .lookup(PDFName.of('Fields'), PDFArray);
      expect(fields.size()).toBe(3);
    }
  });

  it('writes the signature entries CAS writes and names the fields Signature1, 2, 3', async () => {
    let pdf = await createSamplePdf();
    for (let round = 1; round <= 3; round += 1) {
      ({ signed: pdf } = await signOnce(pdf, identity, {
        fields: [{ ...BOX, yRatio: 0.1 + round * 0.2 }],
      }));
    }
    const doc = await PDFDocument.load(pdf);
    const fields = doc.catalog
      .lookup(PDFName.of('AcroForm'), PDFDict)
      .lookup(PDFName.of('Fields'), PDFArray);
    const entries = Array.from({ length: fields.size() }, (_, index) =>
      fields.lookup(index, PDFDict)
    );
    expect(entries.map((field) => field.lookup(PDFName.of('T'), PDFString).decodeText())).toEqual([
      'Signature1',
      'Signature2',
      'Signature3',
    ]);
    const signature = entries[2]!.lookup(PDFName.of('V'), PDFDict);
    const text = (key: string) => signature.lookup(PDFName.of(key), PDFString).decodeText();
    expect([text('Reason'), text('ContactInfo'), text('Location')]).toEqual([
      'eSign document signature',
      'N/A',
      'VN',
    ]);
    const build = signature.lookup(PDFName.of('Prop_Build'), PDFDict);
    expect(build.lookup(PDFName.of('Filter'), PDFDict).get(PDFName.of('Name'))?.toString()).toBe(
      '/Adobe.PPKLite'
    );
    expect(signature.get(PDFName.of('SubFilter'))?.toString()).toBe('/ETSI.CAdES.detached');
    expect(await statuses(pdf, identity)).toEqual(Array(3).fill('SIGNED_VALID'));
  });

  it('reports tampering after signing', async () => {
    const original = await createSamplePdf();
    const { signed } = await signOnce(original, identity);
    // pdf-lib writes page text as hex, so flip a byte in the middle of the original instead.
    const tampered = Buffer.from(signed);
    const at = Math.floor(original.length / 2);
    tampered[at] = tampered[at]! ^ 0x01;
    const [result] = await verifyPdfSignatures(tampered, identity.trustStore);
    expect(result!.status).not.toBe('SIGNED_VALID');
  });

  it('shows one signature in several boxes on different pages', async () => {
    const { signed } = await signOnce(await createSamplePdf({ objectStreams: true }), identity, {
      fields: [BOX, { ...BOX, page: 2, yRatio: 0.1 }, { ...BOX, xRatio: 0.05 }],
    });
    expect(await statuses(signed, identity)).toEqual(['SIGNED_VALID']);
    const doc = await PDFDocument.load(signed);
    const annotCount = (index: number) =>
      (doc.getPage(index).node.lookup(PDFName.of('Annots')) as PDFArray).size();
    expect([annotCount(0), annotCount(1)]).toEqual([2, 1]);
    const fields = doc.catalog
      .lookup(PDFName.of('AcroForm'), PDFDict)
      .lookup(PDFName.of('Fields'), PDFArray);
    expect(fields.size()).toBe(1);
    expect(fields.lookup(0, PDFDict).lookup(PDFName.of('Kids'), PDFArray).size()).toBe(3);
  });

  it('lays out the appearance in wide, narrow and the smallest boxes the UI allows', async () => {
    const boxes = [
      { ...BOX, xRatio: 0.45, widthRatio: 0.5, heightRatio: 0.1 },
      { ...BOX, xRatio: 0.05, widthRatio: 0.2, heightRatio: 0.15 },
      { ...BOX, yRatio: 0.05, widthRatio: 0.16, heightRatio: 0.055 },
    ];
    for (const box of boxes) {
      const { signed } = await signOnce(await createSamplePdf(), identity, { fields: [box] });
      expect(await statuses(signed, identity)).toEqual(['SIGNED_VALID']);
    }
  });

  it("draws VNeID's look with the logo embedded once for every box, and signs again over it", async () => {
    const appearance = {
      name: 'Nguyễn Văn A',
      details: ['Ngày ký: 09/10/2026', 'Giờ ký: 10:42:17 (+07:00)'],
      logoCaption: 'Ký bằng VNeID',
      note: 'Ký bằng kysoqr.com',
    };
    const original = await createSamplePdf();
    const { signed: once } = await signOnce(original, identity, {
      appearance,
      fields: [BOX, { ...BOX, page: 2 }],
    });
    // The logo and its alpha mask, once for both boxes.
    const tail = once.subarray(original.length).toString('latin1');
    expect(tail.match(/\/Subtype \/Image/g)).toHaveLength(2);
    expect(tail).toContain('/Im1');

    const { signed: twice } = await signOnce(once, identity, { appearance });
    expect(await statuses(twice, identity)).toEqual(['SIGNED_VALID', 'SIGNED_VALID']);
  });
});
