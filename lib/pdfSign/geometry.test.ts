import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { appearanceMatrix, type PageGeometry, placeBox } from './geometry.ts';
import { withPdfjs } from './pdfjsHelpers.ts';
import {
  BOX,
  createSamplePdf,
  createSoftIdentity,
  minimalDocument,
  type SamplePage,
  type SoftIdentity,
  signWithIdentity,
} from './testHelpers.ts';

/**
 * The UI draws the box on the page as pdf.js shows it (CropBox ∩ MediaBox,
 * /Rotate applied). These tests sign real files and then ask pdf.js itself
 * where the new widget ends up on screen, and which way its text runs.
 */

const RATIOS = { xRatio: 0.1, yRatio: 0.15, widthRatio: 0.3, heightRatio: 0.12 };

const closeTo = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThan(0.05);

/** A user-space rectangle as pdf.js draws it: origin top-left, y down. */
function screenRect(
  viewport: { convertToViewportPoint(x: number, y: number): number[] },
  rect: number[]
) {
  const [ax, ay] = viewport.convertToViewportPoint(rect[0]!, rect[1]!) as [number, number];
  const [bx, by] = viewport.convertToViewportPoint(rect[2]!, rect[3]!) as [number, number];
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

async function lastWidget(pdf: Buffer) {
  const doc = await PDFDocument.load(pdf);
  const annots = doc.getPage(0).node.Annots()!;
  const widget = annots.lookup(annots.size() - 1, PDFDict);
  const appearance = widget.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFStream);
  const matrix = appearance.dict.lookup(PDFName.of('Matrix'));
  const bbox = appearance.dict.lookup(PDFName.of('BBox'), PDFArray);
  const numbers = (array: PDFArray) => array.asArray().map((n) => (n as PDFNumber).asNumber());
  return {
    rect: numbers(widget.lookup(PDFName.of('Rect'), PDFArray)),
    matrix: matrix instanceof PDFArray ? numbers(matrix) : undefined,
    bbox: numbers(bbox),
  };
}

describe('the widget lands where the user drew it', () => {
  let identity: SoftIdentity;
  beforeAll(() => {
    identity = createSoftIdentity();
  });

  const cases: Array<{ name: string; page: SamplePage }> = [];
  for (const rotate of [0, 90, 180, 270] as const) {
    cases.push({ name: `rotate ${rotate}`, page: { size: [595, 842], rotate } });
    cases.push({
      name: `rotate ${rotate}, CropBox offset`,
      page: { size: [595, 842], rotate, cropBox: [20, 30, 400, 700] },
    });
    cases.push({
      name: `rotate ${rotate}, CropBox larger than the MediaBox`,
      page: { size: [595, 842], rotate, cropBox: [-50, -50, 700, 960] },
    });
    cases.push({ name: `rotate ${rotate}, landscape`, page: { size: [842, 595], rotate } });
  }

  for (const { name, page } of cases) {
    it(name, async () => {
      const { signed } = await signWithIdentity(
        await createSamplePdf({ pages: [page] }),
        identity,
        {
          fields: [{ page: 1, ...RATIOS }],
        }
      );
      const widget = await lastWidget(signed);

      await withPdfjs(signed, async (doc) => {
        const pdfPage = await doc.getPage(1);
        const viewport = pdfPage.getViewport({ scale: 1 });
        const onScreen = screenRect(viewport, widget.rect);

        // Where the user drew it, in displayed points (y measured from the top).
        closeTo(onScreen.left, RATIOS.xRatio * viewport.width);
        closeTo(onScreen.top, RATIOS.yRatio * viewport.height);
        closeTo(onScreen.width, RATIOS.widthRatio * viewport.width);
        closeTo(onScreen.height, RATIOS.heightRatio * viewport.height);

        // Which way the appearance text runs on screen: its x axis must point
        // right and its y axis up (screen y grows downwards).
        const [a, b, c, d] = widget.matrix ?? [1, 0, 0, 1, 0, 0];
        const [ta, tb, tc, td] = viewport.transform as number[];
        const toScreen = (vx: number, vy: number): [number, number] => [
          ta! * vx + tc! * vy,
          tb! * vx + td! * vy,
        ];
        const [xAxisX, xAxisY] = toScreen(a!, b!);
        const [yAxisX, yAxisY] = toScreen(c!, d!);
        closeTo(xAxisX, 1);
        closeTo(xAxisY, 0);
        closeTo(yAxisX, 0);
        closeTo(yAxisY, -1);

        // The turned appearance box has the size of the widget rectangle.
        const [bx, by] = [widget.bbox[2]! - widget.bbox[0]!, widget.bbox[3]! - widget.bbox[1]!];
        const turned = Math.abs(a!) < 0.5 ? [by, bx] : [bx, by];
        closeTo(turned[0]!, Math.abs(widget.rect[2]! - widget.rect[0]!));
        closeTo(turned[1]!, Math.abs(widget.rect[3]! - widget.rect[1]!));
      });
    });
  }

  it('reads a CropBox written with its corners the other way round', async () => {
    const pdf = minimalDocument({ mediaBox: '[0 0 595 842]', page: '/CropBox [500 700 100 100]' });
    const { signed } = await signWithIdentity(pdf, identity, { fields: [{ page: 1, ...RATIOS }] });
    const widget = await lastWidget(signed);
    await withPdfjs(signed, async (doc) => {
      const viewport = (await doc.getPage(1)).getViewport({ scale: 1 });
      expect([viewport.width, viewport.height]).toEqual([400, 600]);
      const onScreen = screenRect(viewport, widget.rect);
      closeTo(onScreen.left, RATIOS.xRatio * 400);
      closeTo(onScreen.top, RATIOS.yRatio * 600);
      closeTo(onScreen.width, RATIOS.widthRatio * 400);
      closeTo(onScreen.height, RATIOS.heightRatio * 600);
    });
  });
});

describe('page geometry is validated', () => {
  const identityPromise = Promise.resolve(createSoftIdentity());
  const sign = async (page: string, mediaBox = '[0 0 595 842]') =>
    signWithIdentity(minimalDocument({ mediaBox, page }), await identityPromise, {
      fields: [{ page: 1, ...RATIOS }],
    });

  it('refuses unusable page sizes', async () => {
    await expect(sign('', '[0 0 10 10]')).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED' });
    await expect(sign('', '[0 0 100000 100000]')).rejects.toMatchObject({
      code: 'PDF_UNSUPPORTED',
    });
    // A CropBox that does not overlap the MediaBox leaves nothing to draw on.
    await expect(sign('/CropBox [1000 1000 1200 1200]')).rejects.toMatchObject({
      code: 'PDF_UNSUPPORTED',
    });
  });

  it('refuses a /UserUnit and a /Rotate that is not a multiple of 90', async () => {
    await expect(sign('/UserUnit 2')).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED' });
    await expect(sign('/Rotate 45')).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED' });
  });

  it('accepts rotations written as 450 or -90', async () => {
    expect((await sign('/Rotate 450')).signed.length).toBeGreaterThan(0);
    expect((await sign('/Rotate -90')).signed.length).toBeGreaterThan(0);
  });
});

describe('placeBox', () => {
  const upright: PageGeometry = {
    x0: 0,
    y0: 0,
    x1: 600,
    y1: 800,
    rotation: 0,
    displayWidth: 600,
    displayHeight: 800,
  };
  const placement = { page: 1, xRatio: 0.1, yRatio: 0.1, widthRatio: 0.3, heightRatio: 0.1 };

  it('rejects ratios outside the page or that run past its edge', () => {
    const bad = [
      { ...placement, xRatio: -0.1 },
      { ...placement, widthRatio: 1.5 },
      { ...placement, xRatio: 0.8, widthRatio: 0.3 },
      { ...placement, yRatio: 0.95, heightRatio: 0.1 },
      { ...placement, xRatio: Number.NaN },
      { ...placement, widthRatio: Number.POSITIVE_INFINITY },
    ];
    for (const box of bad) expect(() => placeBox(upright, box)).toThrowError(/ratio|extends/);
  });

  it('rejects a box too small to hold text', () => {
    expect(() => placeBox(upright, { ...placement, widthRatio: 0.01 })).toThrowError(/small/);
    expect(() => placeBox(upright, { ...placement, heightRatio: 0.005 })).toThrowError(/small/);
  });

  it('appearanceMatrix is undefined only for an upright page', () => {
    expect(appearanceMatrix(0)).toBeUndefined();
    for (const rotation of [90, 180, 270] as const)
      expect(appearanceMatrix(rotation)).toHaveLength(6);
  });
});

void BOX;
