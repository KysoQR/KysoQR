import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * pdf.js is what the UI uses to place the signature box, so tests use it as an
 * independent reader: it must be able to open what we produce, list the
 * annotations that were there before, and put the new box where the user drew
 * it. Test-only.
 */

export async function withPdfjs<T>(
  pdf: Buffer,
  run: (doc: pdfjs.PDFDocumentProxy) => Promise<T>
): Promise<T> {
  const task = pdfjs.getDocument({
    data: new Uint8Array(pdf),
    useSystemFonts: false,
    verbosity: 0,
  });
  try {
    return await run(await task.promise);
  } finally {
    await task.destroy();
  }
}

export interface PdfjsAnnotation {
  subtype: string;
  rect: number[];
  fieldType?: string;
}

export async function annotationsOf(pdf: Buffer, pageNumber: number): Promise<PdfjsAnnotation[]> {
  return withPdfjs(pdf, async (doc) => {
    const page = await doc.getPage(pageNumber);
    return (await page.getAnnotations()) as PdfjsAnnotation[];
  });
}
