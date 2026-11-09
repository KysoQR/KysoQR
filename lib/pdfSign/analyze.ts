import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFParser,
  PDFRef,
  type PDFContext,
} from 'pdf-lib';
import { PdfSignError } from './errors.ts';
import { MAX_PAGES, MAX_PDF_BYTES } from './limits.ts';
import {
  assertFewByteRanges,
  assertNoObjectStreamBomb,
  assertPdfHeader,
  findLastStartXref,
  readXrefSection,
  type XrefKind,
} from './rawPdf.ts';
import type { WidgetSnapshot } from './widgets.ts';
import { alignWithXref } from './xref.ts';

/**
 * Loads an untrusted PDF for signing and reports what an incremental update
 * has to respect. Everything that can refuse a file does so here, before any
 * signing work (and before CSign is called).
 */

export interface PdfAnalysis {
  byteLength: number;
  pageCount: number;
  /** Form of the previous xref section; the update is written the same way. */
  xrefKind: XrefKind;
  /** `startxref` of the previous section: the update's /Prev. */
  prevStartXref: number;
  /** /Size the previous trailer declared. */
  prevSize: number;
  /** Signature dictionaries already in the file (anything with a /ByteRange). */
  signatureCount: number;
  /** 0 = not certified; otherwise the DocMDP permission level (1, 2 or 3). */
  docMdpPermission: 0 | 1 | 2 | 3;
  /** A signed field locks the form so a new field would count as an edit. */
  fieldLocked: boolean;
  acroFormFieldCount: number;
  /** Annotations on each page (index = page number - 1). */
  pageAnnotCounts: number[];
  /** Objects pdf-lib read differently from what the xref points at; the
   * xref's version was used (see xref.ts). Usually 0. */
  realignedObjects: number;
}

/** What a signed file must look like once the update is in (checked by finalize). */
export interface ExpectedAfter {
  pageCount: number;
  signatureCount: number;
  acroFormFieldCount: number;
  pageAnnotCounts: number[];
  /** The widgets pdf.js saw before the update and the field the update adds,
   * one widget per page listed (see widgets.ts). Absent only in updates
   * prepared before this check existed. */
  widgets?: { before: WidgetSnapshot; field: string; pages: number[] } | undefined;
}

export interface LoadedPdf {
  doc: PDFDocument;
  analysis: PdfAnalysis;
  /** Highest object number in use (or declared) before anything is added. */
  baselineObjectNumber: number;
}

const name = (value: string) => PDFName.of(value);

/** Refuses reference-style locking only: an `Include` list names OTHER fields. */
function actionLocksNewFields(action: unknown): boolean {
  return action === name('All') || action === name('Exclude');
}

export async function loadPdfForSigning(
  pdf: Buffer,
  maxBytes: number = MAX_PDF_BYTES
): Promise<LoadedPdf> {
  if (pdf.length > maxBytes)
    throw new PdfSignError('PDF_TOO_LARGE', 'PDF is larger than the limit');
  assertPdfHeader(pdf);
  assertNoObjectStreamBomb(pdf);
  const prevStartXref = findLastStartXref(pdf);
  const section = readXrefSection(pdf, prevStartXref);

  let parsed: PDFContext;
  try {
    // Infinity: don't yield to the event loop every 100 objects -- this runs
    // in a throwaway worker thread, and yielding makes a big file take seconds.
    parsed = await PDFParser.forBytesWithOptions(pdf, Number.POSITIVE_INFINITY).parseDocument();
  } catch {
    throw new PdfSignError('PDF_INVALID', 'PDF could not be parsed');
  }
  // pdf-lib read the file top to bottom, a viewer reads it through the xref.
  // Where the two disagree the update must start from what viewers show, or
  // it can drop the widget of an earlier signature from its page.
  const alignment = alignWithXref(pdf, parsed, prevStartXref);
  if (alignment.replaced.length > 0) {
    console.warn('[pdfSign] the file reads differently through its xref; using the xref version', {
      objects: alignment.replaced.length,
      numbers: alignment.replaced.slice(0, 10).join(','),
    });
  }
  // What PDFDocument.load() does with the context it parses (pdf-lib 1.17.1,
  // pinned); the constructor is private in the typings only.
  const doc = Reflect.construct(PDFDocument, [parsed, true, false]) as PDFDocument;
  const context = doc.context;
  // New objects must not reuse a number the previous trailer already declared.
  const baselineObjectNumber = Math.max(context.largestObjectNumber, section.size - 1);
  context.largestObjectNumber = baselineObjectNumber;

  if (context.trailerInfo.Encrypt !== undefined || doc.isEncrypted) {
    throw new PdfSignError('PDF_ENCRYPTED', 'PDF is encrypted');
  }
  const rootRef = context.trailerInfo.Root;
  if (!(rootRef instanceof PDFRef)) throw new PdfSignError('PDF_INVALID', 'PDF has no catalog');
  const catalog = context.lookupMaybe(rootRef, PDFDict);
  if (!catalog) throw new PdfSignError('PDF_INVALID', 'PDF catalog is missing');

  let pageCount: number;
  try {
    pageCount = doc.getPageCount();
  } catch {
    throw new PdfSignError('PDF_INVALID', 'PDF page tree is unreadable');
  }
  if (pageCount < 1) throw new PdfSignError('PDF_INVALID', 'PDF has no pages');
  if (pageCount > MAX_PAGES) throw new PdfSignError('PDF_TOO_MANY_PAGES', 'PDF has too many pages');

  const pageAnnotCounts: number[] = [];
  try {
    for (const page of doc.getPages()) pageAnnotCounts.push(page.node.Annots()?.size() ?? 0);
  } catch {
    throw new PdfSignError('PDF_UNSUPPORTED', 'page /Annots is not an array');
  }

  const acroForm = catalog.lookup(name('AcroForm'));
  let acroFormFieldCount = 0;
  if (acroForm instanceof PDFDict) {
    // XFA forms render from XML, not from the AcroForm we would extend.
    if (acroForm.has(name('XFA')))
      throw new PdfSignError('PDF_UNSUPPORTED', 'XFA forms are not supported');
    const fields = acroForm.lookup(name('Fields'));
    if (fields instanceof PDFArray) acroFormFieldCount = fields.size();
  }

  let signatureCount = 0;
  let docMdpPermission: 0 | 1 | 2 | 3 = 0;
  let fieldLocked = false;
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;

    const lock = object.lookup(name('Lock'));
    if (
      lock instanceof PDFDict &&
      object.has(name('V')) &&
      actionLocksNewFields(lock.lookup(name('Action')))
    ) {
      fieldLocked = true;
    }

    if (!(object.lookup(name('ByteRange')) instanceof PDFArray)) continue;
    signatureCount += 1;
    const references = object.lookup(name('Reference'));
    if (!(references instanceof PDFArray)) continue;
    for (let i = 0; i < references.size(); i += 1) {
      const reference = references.lookup(i);
      if (!(reference instanceof PDFDict)) continue;
      const method = reference.lookup(name('TransformMethod'));
      const params = reference.lookup(name('TransformParams'));
      if (!(params instanceof PDFDict)) continue;
      if (method === name('DocMDP')) {
        const p = params.lookup(name('P'));
        const level = p instanceof PDFNumber ? p.asNumber() : 2;
        const permission = level === 1 || level === 2 || level === 3 ? level : 1;
        docMdpPermission =
          docMdpPermission === 0
            ? permission
            : (Math.min(docMdpPermission, permission) as 1 | 2 | 3);
      } else if (
        method === name('FieldMDP') &&
        actionLocksNewFields(params.lookup(name('Action')))
      ) {
        fieldLocked = true;
      }
    }
  }

  return {
    doc,
    baselineObjectNumber,
    analysis: {
      byteLength: pdf.length,
      pageCount,
      xrefKind: section.kind,
      prevStartXref,
      prevSize: section.size,
      signatureCount,
      docMdpPermission,
      fieldLocked,
      acroFormFieldCount,
      pageAnnotCounts,
      realignedObjects: alignment.replaced.length,
    },
  };
}

/** What the caller needs to decide whether to go on (cheap enough to be a job of its own). */
export async function analyzePdf(pdf: Buffer): Promise<PdfAnalysis> {
  assertFewByteRanges(pdf);
  const { analysis } = await loadPdfForSigning(pdf);
  return analysis;
}

/** Throws PDF_LOCKED if signing would break an existing certification or lock. */
export function assertSignable(analysis: PdfAnalysis): void {
  if (analysis.docMdpPermission === 1) {
    throw new PdfSignError('PDF_LOCKED', 'document is certified and forbids further changes');
  }
  if (analysis.fieldLocked)
    throw new PdfSignError('PDF_LOCKED', 'a signature locks the form fields');
}
