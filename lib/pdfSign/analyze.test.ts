import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { assertSignable, loadPdfForSigning } from './analyze.ts';
import { MAX_OBJSTM_INFLATED_BYTES, MAX_PDF_BYTES } from './limits.ts';
import { assertNoObjectStreamBomb, findLastStartXref, readXrefSection } from './rawPdf.ts';
import {
  buildClassicPdf,
  createSamplePdf,
  minimalDocument,
  signatureShell,
} from './testHelpers.ts';

const rejects = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });

describe('raw PDF structure', () => {
  it('finds the last startxref and reads the section it points at, for tables and streams', async () => {
    for (const objectStreams of [false, true]) {
      const pdf = await createSamplePdf({ objectStreams });
      const startxref = findLastStartXref(pdf);
      const section = readXrefSection(pdf, startxref);
      expect(section.kind).toBe(objectStreams ? 'stream' : 'table');
      expect(section.size).toBeGreaterThan(3);
    }
  });

  it('tolerates padding after %%EOF', async () => {
    const pdf = Buffer.concat([await createSamplePdf(), Buffer.from('\n\n   \n'.repeat(40))]);
    expect(() => findLastStartXref(pdf)).not.toThrow();
  });

  it('refuses a file with no startxref, or one that points outside the file / at nothing', () => {
    const noStartxref = buildClassicPdf({
      objects: [{ number: 1, body: '<< /Type /Catalog >>' }],
      rawTail: () => 'trailer\n<< /Size 2 /Root 1 0 R >>\n%%EOF\n',
    });
    expect(() => findLastStartXref(noStartxref)).toThrowError(/startxref/);

    const outside = minimalDocument();
    const broken = Buffer.from(
      outside.toString('latin1').replace(/startxref\n\d+/, 'startxref\n99999999'),
      'latin1'
    );
    expect(() => findLastStartXref(broken)).toThrowError(/outside/);

    const atNothing = Buffer.from(
      outside.toString('latin1').replace(/startxref\n\d+/, 'startxref\n20'),
      'latin1'
    );
    expect(() => readXrefSection(atNothing, findLastStartXref(atNothing))).toThrowError(/xref/);
  });
});

describe('loadPdfForSigning', () => {
  it('describes an ordinary file', async () => {
    for (const objectStreams of [false, true]) {
      const { analysis, baselineObjectNumber } = await loadPdfForSigning(
        await createSamplePdf({ objectStreams })
      );
      expect(analysis).toMatchObject({
        pageCount: 2,
        xrefKind: objectStreams ? 'stream' : 'table',
        signatureCount: 0,
        docMdpPermission: 0,
        fieldLocked: false,
        acroFormFieldCount: 0,
        pageAnnotCounts: [0, 0],
      });
      expect(baselineObjectNumber).toBeGreaterThanOrEqual(analysis.prevSize - 1);
    }
  });

  it('refuses things that are not PDFs, or are too large', async () => {
    await rejects(
      loadPdfForSigning(Buffer.from('this is not a pdf, just some text')),
      'PDF_INVALID'
    );
    const huge = Buffer.alloc(MAX_PDF_BYTES + 1);
    huge.write('%PDF-1.7\n');
    await rejects(loadPdfForSigning(huge), 'PDF_TOO_LARGE');
  });

  it('refuses an encrypted file', async () => {
    const pdf = minimalDocument({
      trailer: '/Encrypt 9 0 R',
      objects: [{ number: 9, body: '<< /Filter /Standard /V 1 /R 2 /O (0000) /U (0000) /P -4 >>' }],
    });
    await rejects(loadPdfForSigning(pdf), 'PDF_ENCRYPTED');
  });

  it('refuses XFA forms', async () => {
    const pdf = minimalDocument({
      catalog: '/AcroForm << /Fields [] /XFA [ (template) 9 0 R ] >>',
      objects: [{ number: 9, body: '<< /Length 0 >>\nstream\n\nendstream' }],
    });
    await rejects(loadPdfForSigning(pdf), 'PDF_UNSUPPORTED');
  });

  describe('certified documents and locked fields', () => {
    const certified = (p: number) =>
      minimalDocument({
        catalog: '/Perms << /DocMDP 9 0 R >>',
        objects: [
          {
            number: 9,
            body: signatureShell(
              `<< /Type /SigRef /TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P ${p} /V /1.2 >> >>`
            ),
          },
        ],
      });

    it('counts the signature and reads the DocMDP level', async () => {
      for (const p of [1, 2, 3] as const) {
        const { analysis } = await loadPdfForSigning(certified(p));
        expect(analysis.signatureCount).toBe(1);
        expect(analysis.docMdpPermission).toBe(p);
      }
    });

    it('forbids signing when no changes are allowed (P=1) and allows P=2 and P=3', async () => {
      const analysisOf = async (p: 1 | 2 | 3) => (await loadPdfForSigning(certified(p))).analysis;
      const [p1, p2, p3] = [await analysisOf(1), await analysisOf(2), await analysisOf(3)];
      expect(() => assertSignable(p1)).toThrowError(/certified/);
      expect(() => assertSignable(p2)).not.toThrow();
      expect(() => assertSignable(p3)).not.toThrow();
    });

    it('forbids signing when a signature locks the form (FieldMDP All/Exclude) but not for Include', async () => {
      const locked = (action: string) =>
        minimalDocument({
          objects: [
            {
              number: 9,
              body: signatureShell(
                `<< /Type /SigRef /TransformMethod /FieldMDP /TransformParams << /Type /TransformParams /Action /${action} /Fields [ (other) ] >> >>`
              ),
            },
          ],
        });
      for (const [action, expected] of [
        ['All', true],
        ['Exclude', true],
        ['Include', false],
      ] as const) {
        const { analysis } = await loadPdfForSigning(locked(action));
        expect(analysis.fieldLocked).toBe(expected);
      }
    });

    it('treats a signed field whose /Lock covers everything as a lock', async () => {
      const pdf = minimalDocument({
        objects: [
          { number: 9, body: signatureShell('') },
          {
            number: 10,
            body: '<< /FT /Sig /T (s1) /V 9 0 R /Lock << /Type /SigFieldLock /Action /All >> >>',
          },
        ],
      });
      expect((await loadPdfForSigning(pdf)).analysis.fieldLocked).toBe(true);
    });
  });

  describe('decompression bombs', () => {
    const objectStream = (typeName: string, filter: string, data: Buffer) =>
      minimalDocument({
        objects: [
          {
            number: 9,
            body: `<< /Type ${typeName} /N 1 /First 4 ${filter} /Length ${data.length} >>\nstream\n${data.toString('latin1')}\nendstream`,
          },
        ],
      });
    const bomb = deflateSync(Buffer.alloc(MAX_OBJSTM_INFLATED_BYTES + 1024 * 1024));

    it('refuses an object stream that inflates past the cap, before pdf-lib sees the file', async () => {
      expect(bomb.length).toBeLessThan(100_000);
      await rejects(
        loadPdfForSigning(objectStream('/ObjStm', '/Filter /FlateDecode', bomb)),
        'PDF_UNSUPPORTED'
      );
    });

    it('catches the same stream when the name is written with #xx escapes', async () => {
      expect(() =>
        assertNoObjectStreamBomb(objectStream('/#4fbjStm', '/Filter /FlateDecode', bomb))
      ).toThrowError(/inflates/);
      expect(() =>
        assertNoObjectStreamBomb(objectStream('/ObjStm', '/Filter /FlateDecode', bomb))
      ).toThrowError(/inflates/);
    });

    it('refuses an object stream with a filter chain it cannot bound', () => {
      const chain = objectStream(
        '/ObjStm',
        '/Filter [/ASCIIHexDecode /FlateDecode]',
        Buffer.from('78')
      );
      expect(() => assertNoObjectStreamBomb(chain)).toThrowError(/filter chain/);
    });

    it('lets an ordinary object stream through', async () => {
      const pdf = await createSamplePdf({ objectStreams: true });
      expect(() => assertNoObjectStreamBomb(pdf)).not.toThrow();
    });
  });
});
