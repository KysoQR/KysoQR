import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAppearance, fitText, wrapText } from './appearance.ts';
import { loadAppearanceFonts } from './fonts.ts';

let doc: PDFDocument;
let font: PDFFont;
beforeAll(async () => {
  doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  font = await doc.embedFont(loadAppearanceFonts().regular, { subset: true });
});

const NBSP = String.fromCharCode(0xa0);
const timed = <T>(run: () => T): { result: T; ms: number } => {
  const start = performance.now();
  const result = run();
  return { result, ms: performance.now() - start };
};

describe('wrapText', () => {
  it('refuses a box with no room instead of spinning forever', () => {
    for (const width of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => wrapText('abc', font, 9, width)).toThrowError(/no room/);
    }
    expect(() => wrapText('abc', font, 0, 100)).toThrowError(/no room/);
    expect(() => wrapText('abc', font, Number.NaN, 100)).toThrowError(/no room/);
  });

  it('wraps ordinary text on spaces', () => {
    const lines = wrapText('Ký bởi Nguyễn Văn A qua VNeID ngày hôm nay', font, 9, 80);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe('Ký bởi Nguyễn Văn A qua VNeID ngày hôm nay');
    for (const line of lines) expect(font.widthOfTextAtSize(line, 9)).toBeLessThanOrEqual(80);
  });

  it('keeps a no-break space inside one line', () => {
    const lines = wrapText(`Ngày ký: 03/11/2026 10:15:21${NBSP}+07:00`, font, 9, 120);
    expect(lines.some((line) => line.includes(`10:15:21${NBSP}+07:00`))).toBe(true);
  });

  it('breaks a word wider than the line by characters', () => {
    const word = 'W'.repeat(60);
    const lines = wrapText(word, font, 9, 50);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.join('')).toBe(word);
  });

  it('terminates on a box narrower than one glyph, one character per line', () => {
    const word = 'W'.repeat(500);
    const { result, ms } = timed(() => wrapText(word, font, 9, 1));
    expect(result.join('')).toBe(word);
    expect(result).toHaveLength(500);
    expect(ms).toBeLessThan(1500);
  });

  it('never splits a surrogate pair', () => {
    const emoji = String.fromCodePoint(0x1f600).repeat(40);
    const lines = wrapText(emoji, font, 9, 12);
    expect(lines.join('')).toBe(emoji);
    for (const line of lines) expect(() => encodeURIComponent(line)).not.toThrow();
  });
});

describe('fitText', () => {
  it('stays fast for the longest text the app allows in a small box', () => {
    // 8 detail lines of 160 characters each, in the smallest box the UI offers.
    const paragraphs = Array.from({ length: 8 }, () => 'W'.repeat(160));
    const { result, ms } = timed(() =>
      fitText(paragraphs, font, { width: 60, height: 20 }, { maxSize: 9, minSize: 2.5 })
    );
    expect(result.size).toBeGreaterThanOrEqual(2.5);
    expect(ms).toBeLessThan(3000);
  });

  it('shrinks the type until the text fits, or settles at the minimum', () => {
    const text = ['Ký bởi Nguyễn Văn A', 'Ký qua VNeID', 'Ngày ký: 03/11/2026 10:15:21 +07:00'];
    const roomy = fitText(text, font, { width: 200, height: 80 }, { maxSize: 9, minSize: 2.5 });
    const tight = fitText(text, font, { width: 60, height: 24 }, { maxSize: 9, minSize: 2.5 });
    expect(roomy.size).toBe(9);
    expect(tight.size).toBeLessThan(roomy.size);
  });
});

describe('createAppearance', () => {
  const content = {
    name: 'Nguyễn Văn A',
    details: [`Ngày:${NBSP}09/10/2026${NBSP}10:42:17`, '+07:00'],
  };
  const streamOf = (width: number, height: number) =>
    doc.context
      .lookup(createAppearance(doc.context, { regular: font }, width, height, content))!
      .toString();
  /** [x, y, size, font] of every text line drawn. */
  const linesOf = (stream: string) =>
    [...stream.matchAll(/BT \/(F\d) ([\d.]+) Tf ([\d.-]+) ([\d.-]+) Td/g)].map((m) => ({
      font: m[1],
      size: Number(m[2]),
      x: Number(m[3]),
      y: Number(m[4]),
    }));

  it('lays a wide box out like CAS: check mark left, every line right in one font and size', () => {
    // The size of the box CAS draws.
    const stream = streamOf(208.08, 79.2);
    expect(stream).toContain('0.16 0.6 0.36 RG');
    expect(stream).not.toContain('/F2');
    const lines = linesOf(stream);
    expect(lines).toHaveLength(3);
    expect(new Set(lines.map((line) => line.font))).toEqual(new Set(['F1']));
    expect(new Set(lines.map((line) => line.size))).toEqual(new Set([9.25]));
    for (const line of lines) expect(line.x).toBeGreaterThan(208.08 * 0.34);
    // Left-aligned, top to bottom.
    expect(new Set(lines.map((line) => line.x)).size).toBe(1);
    expect(lines.map((line) => line.y)).toEqual(
      [...lines.map((line) => line.y)].sort((a, b) => b - a)
    );
  });

  it('puts the check mark above the text in a narrow box, and shrinks the type in a small one', () => {
    const narrow = linesOf(streamOf(60, 80));
    // pad 3.6, picture = the top 40% of the 72.8 pt inside.
    for (const line of narrow) expect(line.y).toBeLessThan(80 - 3.6 - 72.8 * 0.4);
    const small = linesOf(streamOf(104, 39.6));
    expect(small).toHaveLength(3);
    expect(small[0]!.size).toBeLessThan(9.25);
  });

  it('shrinks the type rather than wrap a long name', () => {
    const long = { ...content, name: 'Nguyễn Thị Phương Thảo Ngọc Bích Hạnh' };
    const lines = linesOf(
      doc.context
        .lookup(createAppearance(doc.context, { regular: font }, 208.08, 79.2, long))!
        .toString()
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]!.size).toBeLessThan(9.25);
  });

  it('refuses a box without a size', () => {
    for (const [w, h] of [
      [0, 50],
      [50, 0],
      [-1, 50],
      [Number.NaN, 50],
    ] as const) {
      expect(() => createAppearance(doc.context, { regular: font }, w, h, content)).toThrowError(
        /no size/
      );
    }
  });

  it('builds a form XObject, with a /Matrix only when asked', () => {
    const upright = doc.context.lookup(
      createAppearance(doc.context, { regular: font }, 200, 60, content)
    );
    expect(upright?.toString()).toContain('/Subtype /Form');
    expect(upright?.toString()).not.toContain('/Matrix');
    const turned = doc.context.lookup(
      createAppearance(doc.context, { regular: font }, 200, 60, content, [0, 1, -1, 0, 0, 0])
    );
    expect(turned?.toString()).toContain('/Matrix [ 0 1 -1 0 0 0 ]');
  });

  it('draws names as hex glyph ids, so no text can break out of the content stream', () => {
    const hostile = {
      name: '(a) Tj ET q 0 0 m /Evil gs',
      details: ['\\) (\\( << /S /JavaScript >>'],
    };
    const ref = createAppearance(doc.context, { regular: font }, 300, 80, hostile);
    const stream = doc.context.lookup(ref)!.toString();
    // The operators that show text only ever take <hex> operands.
    expect(stream).not.toContain('(a) Tj');
    expect(stream).not.toContain('/JavaScript');
  });
});
