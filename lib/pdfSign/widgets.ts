import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PdfSignError } from './errors.ts';

/**
 * The form widgets -- signature boxes among them -- as a viewer shows them,
 * read with pdf.js: a reader independent of pdf-lib that follows the xref the
 * way Adobe and Chrome do. prepare takes a snapshot of the original, finalize
 * checks the signed file against it. Every widget that was there must still
 * be on its page, in the same place, under the same name and still visible;
 * the new signature's widgets must be there under a name no earlier widget
 * has. Whatever the cause, a signed file in which an earlier signature would
 * no longer show is refused instead of handed out.
 */

export interface WidgetView {
  page: number;
  /** pdf.js id: the annotation's object reference, e.g. "36R". */
  id: string;
  /** Fully qualified field name. */
  field: string;
  /** Field type: Sig, Tx, Btn, Ch, or '' when the widget has none. */
  type: string;
  rect: number[];
  visible: boolean;
  hasAppearance: boolean;
}

export interface WidgetSnapshot {
  pageCount: number;
  widgets: WidgetView[];
}

/** More widgets than this and the file is refused (a form, not a contract). */
export const MAX_WIDGETS = 1000;
/** Annotation flags that keep it off the screen: Hidden (2), NoView (32). */
const INVISIBLE_FLAGS = 2 | 32;

interface PdfjsAnnotation {
  subtype?: string;
  id?: string;
  fieldName?: string;
  fieldType?: string;
  rect?: number[];
  annotationFlags?: number;
  hasAppearance?: boolean;
}

const rounded = (rect: number[] | undefined) =>
  (rect ?? []).map((value) => Math.round(value * 100) / 100);

export async function widgetSnapshot(pdf: Buffer): Promise<WidgetSnapshot> {
  const task = pdfjs.getDocument({
    // A copy: pdf.js may take ownership of the buffer it is given.
    data: new Uint8Array(pdf),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const widgets: WidgetView[] = [];
    for (let number = 1; number <= doc.numPages; number += 1) {
      const page = await doc.getPage(number);
      for (const annotation of (await page.getAnnotations()) as PdfjsAnnotation[]) {
        if (annotation.subtype !== 'Widget') continue;
        if (widgets.length >= MAX_WIDGETS) {
          throw new PdfSignError('PDF_UNSUPPORTED', 'the PDF has too many form widgets');
        }
        widgets.push({
          page: number,
          id: annotation.id ?? '',
          field: annotation.fieldName ?? '',
          type: annotation.fieldType ?? '',
          rect: rounded(annotation.rect),
          visible: ((annotation.annotationFlags ?? 0) & INVISIBLE_FLAGS) === 0,
          hasAppearance: annotation.hasAppearance === true,
        });
      }
      page.cleanup();
    }
    return { pageCount: doc.numPages, widgets };
  } catch (error) {
    if (error instanceof PdfSignError) throw error;
    throw new PdfSignError('PDF_UNSUPPORTED', 'the PDF cannot be read as a viewer reads it');
  } finally {
    await task.destroy();
  }
}

/** Names already used by a form field, from a snapshot. */
export const widgetFieldNames = (snapshot: WidgetSnapshot): string[] =>
  snapshot.widgets.map((widget) => widget.field).filter(Boolean);

/**
 * Why `after` is not "`before` plus the new signature's widgets" (one per
 * box, on `added.pages`, field `added.field`), or undefined when it is. The
 * reason names pages and object ids only.
 */
export function widgetProblem(
  before: WidgetSnapshot,
  after: WidgetSnapshot,
  added: { field: string; pages: number[] }
): string | undefined {
  if (after.pageCount !== before.pageCount) return 'the page count changed';
  const key = (widget: WidgetView) => `${widget.page}:${widget.id}`;
  const now = new Map(after.widgets.map((widget) => [key(widget), widget]));
  for (const old of before.widgets) {
    const still = now.get(key(old));
    const where = `widget ${old.id} on page ${old.page}`;
    if (!still) return `${where} is no longer on its page`;
    if (still.field !== old.field) return `${where} changed its field name`;
    if (still.rect.join() !== old.rect.join()) return `${where} moved`;
    if (old.visible && !still.visible) return `${where} became hidden`;
    if (old.hasAppearance && !still.hasAppearance) return `${where} lost its appearance`;
  }
  const oldKeys = new Set(before.widgets.map(key));
  const fresh = after.widgets.filter((widget) => !oldKeys.has(key(widget)));
  const pages = (list: number[]) => [...list].sort((a, b) => a - b).join();
  if (pages(fresh.map((widget) => widget.page)) !== pages(added.pages)) {
    return 'the new signature widgets are not on the expected pages';
  }
  for (const widget of fresh) {
    if (widget.field !== added.field || widget.type !== 'Sig') {
      return 'a new widget is not the new signature field';
    }
    if (!widget.visible || !widget.hasAppearance) return 'the new signature would not show';
  }
  if (before.widgets.some((widget) => widget.field === added.field)) {
    return 'the new signature field reuses an existing name';
  }
  return undefined;
}
