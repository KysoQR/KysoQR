import { PDFArray, PDFName, PDFNumber, type PDFPage } from 'pdf-lib';
import { PdfSignError } from './errors.ts';
import { MAX_PAGE_SIDE_PT, MIN_PAGE_SIDE_PT } from './limits.ts';

/**
 * Where a signature box lands on the page.
 *
 * The UI places boxes on the page exactly as pdf.js shows it: the CropBox
 * (intersected with the MediaBox) with /Rotate applied, as fractions of the
 * displayed width/height, `yRatio` being the TOP edge measured from the top.
 * The widget's /Rect, however, lives in the page's default user space, which
 * is NOT rotated -- so for a /Rotate 90 page "top-left of the screen" is the
 * bottom-left of the unrotated page, and so on.
 */

export type Rotation = 0 | 90 | 180 | 270;

export interface PageGeometry {
  /** Visible box in default user space (CropBox ∩ MediaBox). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  rotation: Rotation;
  /** Size of the page as displayed (width/height swap for 90 and 270). */
  displayWidth: number;
  displayHeight: number;
}

/** A signature box in the KysoQR UI convention. */
export interface FieldPlacement {
  /** 1-based. */
  page: number;
  xRatio: number;
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
}

export interface PlacedBox {
  /** Widget /Rect in default user space: [llx, lly, urx, ury]. */
  rect: [number, number, number, number];
  /** Size of the box as displayed; the appearance is laid out for this. */
  width: number;
  height: number;
}

/** Smallest box we draw into (the UI never goes below ~0.16 x 0.055 of a page). */
const MIN_BOX_WIDTH_PT = 24;
const MIN_BOX_HEIGHT_PT = 14;
const RATIO_EPSILON = 1e-6;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function readBox(array: PDFArray, label: string): Box {
  if (array.size() !== 4)
    throw new PdfSignError('PDF_UNSUPPORTED', `${label} is not a 4-number array`);
  const values: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const object = array.lookup(i);
    if (!(object instanceof PDFNumber))
      throw new PdfSignError('PDF_UNSUPPORTED', `${label} holds a non-number`);
    const value = object.asNumber();
    if (!Number.isFinite(value))
      throw new PdfSignError('PDF_UNSUPPORTED', `${label} holds a non-finite number`);
    values.push(value);
  }
  const [a, b, c, d] = values as [number, number, number, number];
  // PDF allows any two opposite corners; pdf-lib's asRectangle() would turn an
  // inverted box into a negative width.
  return { x0: Math.min(a, c), y0: Math.min(b, d), x1: Math.max(a, c), y1: Math.max(b, d) };
}

export function pageGeometry(page: PDFPage): PageGeometry {
  const node = page.node;
  let media: Box;
  let crop: Box | undefined;
  try {
    media = readBox(node.MediaBox(), 'MediaBox');
    const cropArray = node.CropBox();
    crop = cropArray ? readBox(cropArray, 'CropBox') : undefined;
  } catch (error) {
    if (error instanceof PdfSignError) throw error;
    throw new PdfSignError('PDF_UNSUPPORTED', 'page box could not be read');
  }

  const x0 = crop ? Math.max(media.x0, crop.x0) : media.x0;
  const y0 = crop ? Math.max(media.y0, crop.y0) : media.y0;
  const x1 = crop ? Math.min(media.x1, crop.x1) : media.x1;
  const y1 = crop ? Math.min(media.y1, crop.y1) : media.y1;
  const width = x1 - x0;
  const height = y1 - y0;
  if (!(
    width >= MIN_PAGE_SIDE_PT &&
    width <= MAX_PAGE_SIDE_PT &&
    height >= MIN_PAGE_SIDE_PT &&
    height <= MAX_PAGE_SIDE_PT
  )) {
    throw new PdfSignError('PDF_UNSUPPORTED', 'page box has an unusable size');
  }

  const userUnit = node.get(PDFName.of('UserUnit'));
  if (userUnit !== undefined && !(userUnit instanceof PDFNumber && userUnit.asNumber() === 1)) {
    throw new PdfSignError('PDF_UNSUPPORTED', 'pages with a /UserUnit are not supported');
  }

  const rotateObject = node.Rotate();
  const rotateRaw = rotateObject ? rotateObject.asNumber() : 0;
  if (!Number.isInteger(rotateRaw))
    throw new PdfSignError('PDF_UNSUPPORTED', 'page /Rotate is not an integer');
  const rotation = ((rotateRaw % 360) + 360) % 360;
  if (rotation !== 0 && rotation !== 90 && rotation !== 180 && rotation !== 270) {
    throw new PdfSignError('PDF_UNSUPPORTED', 'page /Rotate is not a multiple of 90');
  }

  const swapped = rotation === 90 || rotation === 270;
  return {
    x0,
    y0,
    x1,
    y1,
    rotation,
    displayWidth: swapped ? height : width,
    displayHeight: swapped ? width : height,
  };
}

/** Validates a UI placement and maps it to the widget rectangle. */
export function placeBox(geometry: PageGeometry, placement: FieldPlacement): PlacedBox {
  const { xRatio, yRatio, widthRatio, heightRatio } = placement;
  for (const ratio of [xRatio, yRatio, widthRatio, heightRatio]) {
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      throw new PdfSignError('FIELD_INVALID', 'signature box ratio outside 0..1');
    }
  }
  if (xRatio + widthRatio > 1 + RATIO_EPSILON || yRatio + heightRatio > 1 + RATIO_EPSILON) {
    throw new PdfSignError('FIELD_INVALID', 'signature box extends past the page');
  }

  const { displayWidth, displayHeight, x0, y0, x1, y1 } = geometry;
  const dx = xRatio * displayWidth;
  const dy = yRatio * displayHeight;
  const width = widthRatio * displayWidth;
  const height = heightRatio * displayHeight;
  if (width < MIN_BOX_WIDTH_PT || height < MIN_BOX_HEIGHT_PT) {
    throw new PdfSignError('FIELD_INVALID', 'signature box is too small');
  }

  // Display (x right, y DOWN from the top-left) -> unrotated user space (y UP).
  let rect: [number, number, number, number];
  switch (geometry.rotation) {
    case 0:
      rect = [x0 + dx, y1 - dy - height, x0 + dx + width, y1 - dy];
      break;
    case 90:
      rect = [x0 + dy, y0 + dx, x0 + dy + height, y0 + dx + width];
      break;
    case 180:
      rect = [x1 - dx - width, y0 + dy, x1 - dx, y0 + dy + height];
      break;
    case 270:
      rect = [x1 - dy - height, y1 - dx - width, x1 - dy, y1 - dx];
      break;
  }
  return { rect, width, height };
}

/**
 * /Matrix for the appearance stream so its text reads upright on a rotated
 * page: the form is drawn for the displayed orientation and turned back by
 * the page rotation (viewers then fit the turned BBox into the widget /Rect).
 */
export function appearanceMatrix(
  rotation: Rotation
): [number, number, number, number, number, number] | undefined {
  switch (rotation) {
    case 0:
      return undefined;
    case 90:
      return [0, 1, -1, 0, 0, 0];
    case 180:
      return [-1, 0, 0, -1, 0, 0];
    case 270:
      return [0, -1, 1, 0, 0, 0];
  }
}
