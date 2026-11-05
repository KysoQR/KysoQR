import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyPdfSignatures } from '../verification/verifyPdfSignatures';
import { annotationsOf } from './pdfjsHelpers.ts';
import {
  BOX,
  createSamplePdf,
  createSoftIdentity,
  type SoftIdentity,
  signWithIdentity,
} from './testHelpers.ts';

/**
 * The update must add one signature without disturbing anything already in
 * the file: existing form fields, annotations (also when /Annots is an
 * indirect array), object generations, and files that do not end in a newline.
 */

/** Form field + link annotation; page 2 has /Annots as an INDIRECT array of generation 2. */
async function createFormPdf(objectStreams: boolean): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage([595, 842]);
  const text = doc.getForm().createTextField('fullName');
  text.setText('Nguyen Van A');
  text.addToPage(page1, { x: 50, y: 700, width: 200, height: 24 });
  // Make /Fields an indirect array as well.
  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const fields = acroForm.lookup(PDFName.of('Fields'), PDFArray);
  acroForm.set(PDFName.of('Fields'), doc.context.register(fields));

  const page2 = doc.addPage([595, 842]);
  const link = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [10, 10, 100, 40],
      Border: [0, 0, 0],
      A: { S: 'URI', URI: PDFString.of('https://example.test/') },
    })
  );
  const annots = PDFRef.of(900, 2);
  doc.context.assign(annots, doc.context.obj([link]));
  page2.node.set(PDFName.of('Annots'), annots);
  return Buffer.from(await doc.save({ useObjectStreams: objectStreams }));
}

describe('an existing form, annotations and generations are preserved', () => {
  let identity: SoftIdentity;
  beforeAll(() => {
    identity = createSoftIdentity();
  });

  for (const objectStreams of [false, true]) {
    it(`keeps fields and annotations (objectStreams=${objectStreams})`, async () => {
      const original = await createFormPdf(objectStreams);
      const before = await PDFDocument.load(original);
      expect(before.getPage(1).node.get(PDFName.of('Annots'))?.toString()).toBe('900 2 R');

      const { prepared, signed } = await signWithIdentity(original, identity, {
        fields: [{ ...BOX, page: 2 }],
      });
      expect(prepared.analysis).toMatchObject({ acroFormFieldCount: 1, pageAnnotCounts: [1, 1] });
      expect(prepared.expected).toMatchObject({
        acroFormFieldCount: 2,
        pageAnnotCounts: [1, 2],
        signatureCount: 1,
      });

      // The array that was modified keeps its number AND generation.
      expect(signed.toString('latin1', original.length)).toContain('900 2 obj');
      const [result] = await verifyPdfSignatures(signed, identity.trustStore);
      expect(result!.status).toBe('SIGNED_VALID');

      // Read back by two independent parsers.
      const after = await PDFDocument.load(signed);
      expect(after.getPage(1).node.get(PDFName.of('Annots'))?.toString()).toBe('900 2 R');
      const names = after
        .getForm()
        .getFields()
        .map((field) => field.getName());
      expect(names).toContain('fullName');
      expect(names).toHaveLength(2);

      expect((await annotationsOf(signed, 1)).map((a) => a.subtype)).toEqual(['Widget']);
      expect((await annotationsOf(signed, 2)).map((a) => a.subtype).sort()).toEqual([
        'Link',
        'Widget',
      ]);
    });
  }

  it('signs again on top of the same form and keeps all of it', async () => {
    const original = await createFormPdf(true);
    const first = await signWithIdentity(original, identity, {
      fields: [{ ...BOX, page: 1, yRatio: 0.5 }],
      signingTime: new Date(Date.now() + 1000),
    });
    const second = await signWithIdentity(first.signed, identity, {
      fields: [{ ...BOX, page: 1, yRatio: 0.3 }],
      signingTime: new Date(Date.now() + 2000),
    });
    expect(second.prepared.analysis.signatureCount).toBe(1);
    const results = await verifyPdfSignatures(second.signed, identity.trustStore);
    expect(results.map((r) => r.status)).toEqual(['SIGNED_VALID', 'SIGNED_VALID']);
    // text field + two signature widgets on page 1; the link and the second page are untouched.
    expect((await annotationsOf(second.signed, 1)).map((a) => a.subtype)).toEqual([
      'Widget',
      'Widget',
      'Widget',
    ]);
    expect((await annotationsOf(second.signed, 2)).map((a) => a.subtype)).toEqual(['Link']);
  });

  it('signs a file however its last line ends: no newline, CR, LF, CRLF', async () => {
    for (const ending of ['', '\r', '\n', '\r\n']) {
      const pdf = await createSamplePdf();
      expect(pdf.toString('latin1', pdf.length - 5)).toBe('%%EOF'); // pdf-lib writes no final newline
      const original = Buffer.concat([pdf, Buffer.from(ending)]);
      const { signed } = await signWithIdentity(original, identity);
      expect(signed.subarray(0, original.length).equals(original)).toBe(true);
      const results = await verifyPdfSignatures(signed, identity.trustStore);
      expect(results.map((r) => r.status)).toEqual(['SIGNED_VALID']);
    }
  });

  it('signs a file with padding after %%EOF', async () => {
    const original = Buffer.concat([await createSamplePdf(), Buffer.from('\n   \n'.repeat(30))]);
    const { signed } = await signWithIdentity(original, identity);
    const results = await verifyPdfSignatures(signed, identity.trustStore);
    expect(results.map((r) => r.status)).toEqual(['SIGNED_VALID']);
  });
});
