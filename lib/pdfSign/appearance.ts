import type { PDFContext, PDFFont, PDFRef } from 'pdf-lib';
import { PdfSignError } from './errors.ts';

/**
 * Visible signature box, laid out like the one CAS (Cas ID) draws: a picture
 * on the left and, on the right, the signer's name and the details, one per
 * line, in one size (the picture goes above the text when the box is narrow).
 * The picture is a green check mark, or -- with `logoCaption` -- VNeID's logo
 * with that caption under it and the name in semibold. No background or
 * border: the page shows through.
 *
 * Ported from the USB-token agent (agent/src/pdf/appearance.ts) with two
 * changes: `wrapText` can no longer loop forever (a box with no usable width
 * used to spin until the process died), and the form can carry a /Matrix so it
 * reads upright on a rotated page.
 */

export interface AppearanceContent {
  /** Signer name, the first line. */
  name: string;
  /** The lines below it (wrapped as needed). */
  details: string[];
  /** Caption under VNeID's logo (e.g. "Ký bằng VNeID"); without it, a check mark. */
  logoCaption?: string;
  /** Last line, in green (e.g. "Ký bằng kysoqr.com"). */
  note?: string;
}

export interface AppearanceFonts {
  regular: PDFFont;
  /** The name's font; the regular one when absent. */
  bold?: PDFFont;
}

/** One line of text with its font and fill colour. */
interface StyledLine {
  text: string;
  font: PDFFont;
  fontName: string;
  color: string;
}

interface FitLimits {
  maxSize: number;
  minSize: number;
  maxLines?: number;
}

interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Line spacing of the CAS box: 1.25 times the type size. */
const LINE_HEIGHT = 1.25;
/** CAS sets 9.25 pt type in its 79.2 pt high box: the same ratio here, never larger. */
const MAX_TEXT_SIZE = 9.25;
const TEXT_SIZE_PER_HEIGHT = 9.25 / 79.2;
/** Share of the width left of the text. CAS gives its picture 41%; Be Vietnam
 * Pro runs wider than CAS's Times, so the text gets a little more room here
 * (the date line then fits at 9.25 pt in a box the size of CAS's). */
const PICTURE_SHARE = 0.34;
const num = (value: number) => Number(value.toFixed(2)).toString();
/** Brand green for text (caption, note); near-black for the rest. */
const GREEN_TEXT = '0.09 0.45 0.25';
const INK = '0.1 0.1 0.1';

/**
 * Greedy word wrap; a word wider than the line is broken by characters, and a
 * single character wider than the line is emitted as-is (clipped by the box)
 * instead of retrying forever.
 */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0 || !Number.isFinite(size) || size <= 0) {
    throw new PdfSignError('FIELD_INVALID', 'no room to lay out the signature text');
  }
  const lines: string[] = [];
  let line = '';
  const fits = (candidate: string) => font.widthOfTextAtSize(candidate, size) <= maxWidth;
  // Only plain spaces break a line: a no-break space (U+00A0) keeps e.g.
  // "11:29:21 +07:00" together.
  for (const word of text.split(/[ \t\n]+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    // A word wider than the line is cut by characters. Work on code points so
    // a cut never splits a surrogate pair, and measure each character once:
    // re-measuring growing prefixes is cubic in the word length, which a long
    // unbreakable name in a narrow box would turn into a CPU bomb.
    const chars = Array.from(word);
    const widths = chars.map((char) => font.widthOfTextAtSize(char, size));
    let start = 0;
    while (start < chars.length) {
      let end = start;
      let width = 0;
      // Always takes at least one character, so the loop cannot stall on a
      // glyph wider than the box (it is drawn anyway and clipped).
      while (end < chars.length && (end === start || width + widths[end]! <= maxWidth)) {
        width += widths[end]!;
        end += 1;
      }
      if (end >= chars.length) {
        line = chars.slice(start).join('');
        break;
      }
      lines.push(chars.slice(start, end).join(''));
      start = end;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Largest font size (binary search) at which `paragraphs` wrap into `area`
 * with at most `maxLines` lines; returns that size and the wrapped lines. */
export function fitText(
  paragraphs: string[],
  font: PDFFont,
  area: Pick<Area, 'width' | 'height'>,
  limits: FitLimits
): { size: number; lines: string[] } {
  const fitted = fitLines(
    paragraphs.map((text) => ({ text, font })),
    area,
    limits
  );
  return { size: fitted.size, lines: fitted.lines.map((line) => line.text) };
}

/** fitText for paragraphs that each carry their own font (and colour). */
function fitLines<T extends { text: string; font: PDFFont }>(
  paragraphs: T[],
  area: Pick<Area, 'width' | 'height'>,
  { maxSize, minSize, maxLines = Infinity }: FitLimits
): { size: number; lines: T[] } {
  const layout = (size: number) =>
    paragraphs.flatMap((p) =>
      wrapText(p.text, p.font, size, area.width).map((text) => ({ ...p, text }))
    );
  const fits = (size: number) => {
    const lines = layout(size);
    return lines.length <= maxLines && lines.length * size * LINE_HEIGHT <= area.height;
  };
  let low = minSize;
  let high = Math.max(minSize, maxSize);
  if (fits(high)) return { size: high, lines: layout(high) };
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) / 2;
    if (fits(mid)) low = mid;
    else high = mid;
  }
  return { size: low, lines: layout(low) };
}

/** Text operators for `lines`, vertically centred in `area`. */
function textBlock(
  lines: StyledLine[],
  size: number,
  area: Area,
  align: 'left' | 'center'
): string {
  const leading = size * LINE_HEIGHT;
  const blockHeight = lines.length * leading;
  // First baseline: top of the centred block, minus roughly one ascent.
  let baseline = area.y + (area.height + blockHeight) / 2 - size * 0.95;
  return lines
    .map((line) => {
      const width = line.font.widthOfTextAtSize(line.text, size);
      const x = align === 'center' ? area.x + (area.width - width) / 2 : area.x;
      // encodeText() yields a hex string (<...>) of glyph ids, so nothing the
      // signer's name contains can break out of the content stream.
      const op = `${line.color} rg BT /${line.fontName} ${num(size)} Tf ${num(x)} ${num(baseline)} Td ${line.font.encodeText(line.text).toString()} Tj ET`;
      baseline -= leading;
      return op;
    })
    .join('\n');
}

/** Green check mark centred in `area`, where CAS puts the signer's picture
 * (vector, no image needed). */
function checkMark(area: Area): string {
  const side = Math.min(area.width, area.height) * 0.9;
  const x0 = area.x + (area.width - side) / 2;
  const y0 = area.y + (area.height - side) / 2;
  const p = (fx: number, fy: number) => `${num(x0 + fx * side)} ${num(y0 + fy * side)}`;
  return [
    'q 0.16 0.6 0.36 RG',
    `${num(side * 0.12)} w 1 J 1 j`,
    `${p(0.12, 0.52)} m ${p(0.4, 0.22)} l ${p(0.9, 0.82)} l S`,
    'Q',
  ].join('\n');
}

/** VNeID's logo (image /Im1) centred in `area`, `caption` in small green type
 * under it; the caption shrinks to the area's width. */
function logoWithCaption(area: Area, caption: string, font: PDFFont, fontName: string): string {
  let size = Math.max(2.5, Math.min(7, area.height * 0.11));
  const fullWidth = font.widthOfTextAtSize(caption, size);
  if (fullWidth > area.width) size = Math.max(2.5, (size * area.width) / fullWidth);
  const captionHeight = size * LINE_HEIGHT;
  const gap = size * 0.4;
  const side = Math.max(0, Math.min(area.width, area.height - captionHeight - gap));
  // Logo and caption as one block, centred in the area.
  const top = area.y + (area.height + side + gap + captionHeight) / 2;
  const x = area.x + (area.width - side) / 2;
  const captionX = area.x + (area.width - font.widthOfTextAtSize(caption, size)) / 2;
  const baseline = top - side - gap - size * 0.95;
  return [
    `q ${num(side)} 0 0 ${num(side)} ${num(x)} ${num(top - side)} cm /Im1 Do Q`,
    `q ${GREEN_TEXT} rg BT /${fontName} ${num(size)} Tf ${num(captionX)} ${num(baseline)} Td ${font.encodeText(caption).toString()} Tj ET Q`,
  ].join('\n');
}

/**
 * Registers the appearance XObject for a `width` x `height` box. `width` and
 * `height` are the DISPLAYED size; `matrix` (see geometry.appearanceMatrix)
 * turns the form back for a rotated page.
 */
export function createAppearance(
  context: PDFContext,
  fonts: AppearanceFonts,
  width: number,
  height: number,
  content: AppearanceContent,
  matrix?: readonly number[],
  /** VNeID's logo (an image XObject), drawn when the content has a logoCaption. */
  logo?: PDFRef
): PDFRef {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new PdfSignError('FIELD_INVALID', 'signature box has no size');
  }
  const caption = logo ? content.logoCaption : undefined;
  const pad = Math.max(1.5, Math.min(6, Math.min(width, height) * 0.06));
  const inner: Area = { x: pad, y: pad, width: width - 2 * pad, height: height - 2 * pad };
  const sideBySide = width >= height * 1.6;

  let pictureArea: Area;
  let textArea: Area;
  if (sideBySide) {
    // The logo is square: in a long box its column stops at about the box's
    // height, so the text sits next to it instead of far to the right.
    const pictureWidth = Math.min(
      inner.width * PICTURE_SHARE,
      caption ? inner.height * 1.05 : Infinity
    );
    pictureArea = { ...inner, width: pictureWidth };
    textArea = {
      ...inner,
      x: inner.x + pictureWidth + pad,
      width: inner.width - pictureWidth - pad,
    };
  } else {
    const pictureHeight = inner.height * 0.4;
    pictureArea = { ...inner, y: inner.y + inner.height - pictureHeight, height: pictureHeight };
    textArea = { ...inner, height: inner.height - pictureHeight - pad * 0.5 };
  }

  // One line each, as CAS draws them: the type shrinks before a line wraps.
  const regular = { font: fonts.regular, fontName: 'F1' };
  const nameFont = fonts.bold ? { font: fonts.bold, fontName: 'F2' } : regular;
  const paragraphs: StyledLine[] = [
    { text: content.name, ...nameFont, color: INK },
    ...content.details.filter(Boolean).map((text) => ({ text, ...regular, color: INK })),
    ...(content.note ? [{ text: content.note, ...regular, color: GREEN_TEXT }] : []),
  ];
  const text = fitLines(paragraphs, textArea, {
    maxSize: Math.max(2.5, Math.min(MAX_TEXT_SIZE, height * TEXT_SIZE_PER_HEIGHT)),
    minSize: 2.5,
    maxLines: paragraphs.length,
  });

  const ops = [
    caption
      ? logoWithCaption(pictureArea, caption, nameFont.font, nameFont.fontName)
      : checkMark(pictureArea),
    'q',
    textBlock(text.lines, text.size, textArea, sideBySide ? 'left' : 'center'),
    'Q',
  ]
    .filter(Boolean)
    .join('\n');

  return context.register(
    context.stream(ops, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, width, height],
      ...(matrix ? { Matrix: [...matrix] } : {}),
      Resources: {
        Font: { F1: fonts.regular.ref, ...(fonts.bold ? { F2: fonts.bold.ref } : {}) },
        ...(caption && logo ? { XObject: { Im1: logo } } : {}),
      },
    })
  );
}
