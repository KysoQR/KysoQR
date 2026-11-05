import { deflateSync } from 'node:zlib';
import { PDFDict, PDFDocument, PDFName, PDFParser, PDFRef } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { findLastStartXref } from './rawPdf.ts';
import {
  createSamplePdf,
  createSoftIdentity,
  minimalDocument,
  type SoftIdentity,
  signWithIdentity,
} from './testHelpers.ts';
import { alignWithXref, readXrefChain, XrefReader, XrefUnusableError } from './xref.ts';

const parse = (pdf: Buffer) => PDFParser.forBytesWithOptions(pdf, Infinity).parseDocument();
const chainOf = (pdf: Buffer) => readXrefChain(pdf, findLastStartXref(pdf));
const alignAgain = async (pdf: Buffer) =>
  alignWithXref(pdf, await parse(pdf), findLastStartXref(pdf));

/** Objects laid out by hand; the caller writes the xref part. */
function layout(objects: { number: number; body: string }[]) {
  let text = '%PDF-1.7\n';
  const offsets = new Map<number, number>();
  for (const object of objects) {
    offsets.set(object.number, text.length);
    text += `${object.number} 0 obj\n${object.body}\nendobj\n`;
  }
  return { text, offsets };
}

const streamBody = (dict: string, data: Buffer) =>
  `<< ${dict} /Length ${data.length} >>\nstream\n${data.toString('latin1')}\nendstream`;

/** PNG "Up" rows, the way xref streams usually come. */
function pngUp(rows: number[][]): Buffer {
  const out: number[] = [];
  rows.forEach((row, r) => {
    out.push(2);
    row.forEach((value, c) => out.push((value - (r > 0 ? rows[r - 1]![c]! : 0) + 256) & 0xff));
  });
  return Buffer.from(out);
}

const PAGE_TREE = [
  { number: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
  { number: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  { number: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>' },
];

describe('readXrefChain / XrefReader', () => {
  let identity: SoftIdentity;
  beforeAll(() => {
    identity = createSoftIdentity();
  });

  for (const objectStreams of [false, true]) {
    it(`follows /Prev through an incremental update (objectStreams=${objectStreams})`, async () => {
      const original = await createSamplePdf({ objectStreams });
      const { signed } = await signWithIdentity(original, identity);
      const chain = chainOf(signed);
      expect(chain.sections).toBe(2);
      const root = chain.trailer.get(PDFName.of('Root'));
      expect(root).toBeInstanceOf(PDFRef);

      // The update rewrote the catalog: its newest entry is past the original.
      const entry = chain.entries.get((root as PDFRef).objectNumber);
      expect(entry?.kind).toBe('offset');
      expect(entry?.kind === 'offset' && entry.offset).toBeGreaterThan(original.length);
      const reader = new XrefReader(signed, await parse(signed), chain);
      const catalog = reader.resolve(root as PDFRef);
      expect(catalog).toBeInstanceOf(PDFDict);
      expect((catalog as PDFDict).has(PDFName.of('AcroForm'))).toBe(true);
    });
  }

  it('reads an xref stream that uses the PNG predictor', async () => {
    const { text, offsets } = layout(PAGE_TREE);
    const xrefAt = text.length;
    const row = (type: number, value: number, generation: number) => [
      type,
      value >> 8,
      value & 0xff,
      generation,
    ];
    const rows = [
      row(0, 0, 255),
      row(1, offsets.get(1)!, 0),
      row(1, offsets.get(2)!, 0),
      row(1, offsets.get(3)!, 0),
      row(1, xrefAt, 0),
    ];
    const dict =
      '/Type /XRef /Size 5 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode ' +
      '/DecodeParms << /Predictor 12 /Columns 4 >>';
    const xref = streamBody(dict, deflateSync(pngUp(rows)));
    const pdf = Buffer.from(
      `${text}4 0 obj\n${xref}\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`,
      'latin1'
    );
    const chain = chainOf(pdf);
    expect(chain.entries.get(0)).toEqual({ kind: 'free' });
    expect(chain.entries.get(3)).toEqual({ kind: 'offset', offset: offsets.get(3), generation: 0 });
    const page = new XrefReader(pdf, await parse(pdf), chain).resolve(PDFRef.of(3, 0));
    expect((page as PDFDict).get(PDFName.of('Type'))).toBe(PDFName.of('Page'));
  });

  it('reads a hybrid file: an object listed only by /XRefStm, inside an object stream', async () => {
    const objStm = deflateSync(Buffer.from('4 0 << /Kind (inside) >>', 'latin1'));
    const { text, offsets } = layout([
      ...PAGE_TREE,
      { number: 5, body: streamBody('/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode', objStm) },
    ]);
    const xrefStmAt = text.length;
    const stm = deflateSync(Buffer.from([2, 0, 5, 0]));
    const stmDict = '/Type /XRef /Size 7 /W [1 2 1] /Index [4 1] /Filter /FlateDecode';
    let out = `${text}6 0 obj\n${streamBody(stmDict, stm)}\nendobj\n`;
    const tableAt = out.length;
    const at = (n: number) => `${String(n).padStart(10, '0')} 00000 n \n`;
    out +=
      'xref\n0 4\n0000000000 65535 f \n' +
      at(offsets.get(1)!) +
      at(offsets.get(2)!) +
      at(offsets.get(3)!) +
      `5 2\n${at(offsets.get(5)!)}${at(xrefStmAt)}` +
      `trailer\n<< /Size 7 /Root 1 0 R /XRefStm ${xrefStmAt} >>\nstartxref\n${tableAt}\n%%EOF\n`;
    const pdf = Buffer.from(out, 'latin1');

    const chain = chainOf(pdf);
    expect(chain.entries.get(4)).toEqual({ kind: 'compressed', stream: 5, index: 0 });
    const object = new XrefReader(pdf, await parse(pdf), chain).resolve(PDFRef.of(4, 0));
    expect((object as PDFDict).get(PDFName.of('Kind'))?.toString()).toBe('(inside)');
  });

  it('gives up on a /Prev loop or an offset that points at the wrong object', async () => {
    const base = minimalDocument().toString('latin1');
    const xrefAt = Number(/startxref\n(\d+)/.exec(base)![1]);
    const loop = Buffer.from(base.replace('/Root 1 0 R', `/Root 1 0 R /Prev ${xrefAt}`), 'latin1');
    expect(() => chainOf(loop)).toThrow(XrefUnusableError);
    expect(await alignAgain(loop)).toEqual({ usable: false, replaced: [] });

    // Object 3's entry points at object 2.
    const entryOf = (offset: number) => `${String(offset).padStart(10, '0')} 00000 n`;
    const wrong = Buffer.from(
      base.replace(entryOf(base.indexOf('3 0 obj')), entryOf(base.indexOf('2 0 obj'))),
      'latin1'
    );
    const reader = new XrefReader(wrong, await parse(wrong), chainOf(wrong));
    expect(() => reader.resolve(PDFRef.of(3, 0))).toThrow(XrefUnusableError);
    expect(await alignAgain(wrong)).toEqual({ usable: false, replaced: [] });
  });
});

describe('alignWithXref', () => {
  it('changes nothing in an ordinary file', async () => {
    for (const objectStreams of [false, true]) {
      expect(await alignAgain(await createSamplePdf({ objectStreams }))).toEqual({
        usable: true,
        replaced: [],
      });
    }
  });

  it('replaces what pdf-lib read from an object written again after the last xref', async () => {
    const base = minimalDocument({
      page: '/Annots [4 0 R]',
      objects: [{ number: 4, body: '<< /Type /Annot /Subtype /Text /Rect [0 0 10 10] >>' }],
    });
    // A stale copy of the page (no /Annots) after %%EOF: no xref lists it, so
    // viewers never see it, but pdf-lib reads it last and keeps it.
    const orphan = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n';
    const stale = Buffer.concat([base, Buffer.from(orphan, 'latin1')]);
    expect((await PDFDocument.load(stale)).getPage(0).node.Annots()).toBeUndefined();

    const context = await parse(stale);
    expect(alignWithXref(stale, context, findLastStartXref(stale))).toEqual({
      usable: true,
      replaced: [3],
    });
    const page = context.lookup(PDFRef.of(3, 0), PDFDict);
    expect(page.lookup(PDFName.of('Annots'))?.toString()).toBe('[ 4 0 R ]');
  });
});
