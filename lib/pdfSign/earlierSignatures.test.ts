import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyPdfSignatures } from '../verification/verifyPdfSignatures';
import { finalizePdf } from './finalize.ts';
import { annotationsOf } from './pdfjsHelpers.ts';
import {
  createSoftIdentity,
  minimalDocument,
  type SoftIdentity,
  signWithIdentity,
} from './testHelpers.ts';
import { type WidgetSnapshot, widgetProblem, type WidgetView } from './widgets.ts';

/**
 * Signing again must never make an earlier signature disappear from its page
 * (it would stay in the signature panel but no longer show). Two ways it can
 * happen are covered here -- pdf-lib reading a stale object the xref does not
 * point at, and a field name that is already taken -- plus the check that
 * refuses any signed file in which an earlier widget no longer shows.
 */

const signatureWidgets = async (pdf: Buffer) =>
  (await annotationsOf(pdf, 1))
    .filter((annotation) => annotation.fieldType === 'Sig')
    .map((annotation) => (annotation as { fieldName?: string }).fieldName)
    .sort();

/** A signature-looking widget on page 1 (object 4) with its appearance (object 5). */
const WIDGET_OBJECTS = (fieldEntries: string) => [
  {
    number: 4,
    body:
      `<< /Type /Annot /Subtype /Widget /FT /Sig ${fieldEntries} /Rect [20 20 220 100] ` +
      '/F 4 /P 3 0 R /AP << /N 5 0 R >> >>',
  },
  {
    number: 5,
    body: '<< /Type /XObject /Subtype /Form /BBox [0 0 200 80] /Length 8 >>\nstream\n0 0 m S\n\nendstream',
  },
];

describe('earlier signatures stay visible', () => {
  let identity: SoftIdentity;
  beforeAll(() => {
    identity = createSoftIdentity();
  });

  it('keeps an earlier signature that pdf-lib alone would read off the page', async () => {
    const original = minimalDocument();
    const { signed: once } = await signWithIdentity(original, identity);
    expect(await signatureWidgets(once)).toEqual(['Signature1']);

    // The page as it was before the first signature, written again after
    // %%EOF: no xref points at it, so viewers ignore it -- but pdf-lib reads
    // the file top to bottom, keeps it, and sees a page with no signature.
    const orphan = '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n';
    const stale = Buffer.concat([once, Buffer.from(orphan, 'latin1')]);
    expect((await PDFDocument.load(stale)).getPage(0).node.Annots()).toBeUndefined();

    const { prepared, signed: twice } = await signWithIdentity(stale, identity);
    expect(prepared.analysis.realignedObjects).toBeGreaterThan(0);
    expect(prepared.analysis.pageAnnotCounts).toEqual([1]);
    expect(await signatureWidgets(twice)).toEqual(['Signature1', 'Signature2']);
    const results = await verifyPdfSignatures(twice, identity.trustStore);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.contentIntact)).toBe(true);
  });

  it('does not reuse the name of a signature widget that is missing from /Fields', async () => {
    const original = minimalDocument({
      page: '/Annots [4 0 R]',
      objects: WIDGET_OBJECTS('/T (Signature1)'),
    });
    const { prepared, signed } = await signWithIdentity(original, identity);
    expect(prepared.expected.widgets?.field).toBe('Signature2');
    expect(await signatureWidgets(signed)).toEqual(['Signature1', 'Signature2']);
  });

  it('reads names as fully qualified: Form.Signature1 leaves Signature1 free', async () => {
    const original = minimalDocument({
      catalog: '/AcroForm << /Fields [6 0 R] >>',
      page: '/Annots [4 0 R]',
      objects: [
        ...WIDGET_OBJECTS('/T (Signature1) /Parent 6 0 R'),
        { number: 6, body: '<< /T (Form) /Kids [4 0 R] >>' },
      ],
    });
    const { prepared, signed } = await signWithIdentity(original, identity);
    expect(prepared.expected.widgets?.field).toBe('Signature1');
    expect(await signatureWidgets(signed)).toEqual(['Form.Signature1', 'Signature1']);
  });

  it('refuses a signed file in which an earlier widget no longer shows', async () => {
    const original = minimalDocument();
    const { prepared, signature } = await signWithIdentity(original, identity);
    const ghost: WidgetView = {
      page: 1,
      id: '999R',
      field: 'Older',
      type: 'Sig',
      rect: [1, 1, 2, 2],
      visible: true,
      hasAppearance: true,
    };
    const widgets = prepared.expected.widgets!;
    await expect(
      finalizePdf({
        original,
        ...prepared,
        expected: {
          ...prepared.expected,
          widgets: { ...widgets, before: { ...widgets.before, widgets: [ghost] } },
        },
        certificateDer: identity.certificateDer,
        chainDer: identity.chainDer,
        signature,
      })
    ).rejects.toMatchObject({ code: 'SELF_CHECK_FAILED', message: /999R on page 1/ });
  });
});

describe('widgetProblem', () => {
  const old: WidgetView = {
    page: 1,
    id: '36R',
    field: 'Signature1',
    type: 'Sig',
    rect: [10, 10, 200, 80],
    visible: true,
    hasAppearance: true,
  };
  const added: WidgetView = { ...old, id: '62R', field: 'Signature2', rect: [300, 10, 500, 80] };
  const before: WidgetSnapshot = { pageCount: 2, widgets: [old] };
  const after = (...widgets: WidgetView[]): WidgetSnapshot => ({ pageCount: 2, widgets });
  const expected = { field: 'Signature2', pages: [1] };

  it('accepts the earlier widgets untouched plus the new one', () => {
    expect(widgetProblem(before, after(old, added), expected)).toBeUndefined();
    // An earlier widget that was hidden may stay hidden.
    const hidden = { ...old, visible: false };
    expect(widgetProblem({ ...before, widgets: [hidden] }, after(hidden, added), expected)).toBe(
      undefined
    );
  });

  it('names what went wrong with an earlier widget', () => {
    expect(widgetProblem(before, after(added), expected)).toMatch(/36R on page 1 is no longer/);
    expect(widgetProblem(before, after({ ...old, visible: false }, added), expected)).toMatch(
      /became hidden/
    );
    expect(widgetProblem(before, after({ ...old, rect: [0, 0, 1, 1] }, added), expected)).toMatch(
      /moved/
    );
    expect(widgetProblem(before, after({ ...old, field: 'X' }, added), expected)).toMatch(
      /field name/
    );
    expect(widgetProblem(before, after({ ...old, hasAppearance: false }, added), expected)).toMatch(
      /appearance/
    );
    expect(widgetProblem(before, { ...after(old, added), pageCount: 3 }, expected)).toMatch(
      /page count/
    );
  });

  it('checks the new widgets: pages, field, visibility, a name of its own', () => {
    expect(widgetProblem(before, after(old), expected)).toMatch(/expected pages/);
    expect(widgetProblem(before, after(old, added), { ...expected, pages: [2] })).toMatch(
      /expected pages/
    );
    expect(widgetProblem(before, after(old, { ...added, type: 'Tx' }), expected)).toMatch(
      /not the new signature field/
    );
    expect(widgetProblem(before, after(old, { ...added, visible: false }), expected)).toMatch(
      /would not show/
    );
    const reused = { ...added, field: 'Signature1' };
    expect(widgetProblem(before, after(old, reused), { ...expected, field: 'Signature1' })).toMatch(
      /reuses an existing name/
    );
  });
});
