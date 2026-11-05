#!/usr/bin/env node
/**
 * Checks that PDFs you already have can be signed again by KysoQR without an
 * earlier signature disappearing from its page -- WITHOUT signing anything
 * for real: each file is signed in memory with a throwaway test key, nothing
 * is written and CSign is never called.
 *
 *   npm run pdf:sign-check -- <file.pdf> [<file.pdf> ...]
 *
 * Per file: its pages, signatures and signature boxes; whether pdf-lib reads
 * any object differently from what the xref points at (the cause of earlier
 * signatures vanishing, now corrected); the field name the new signature
 * would get; and whether every earlier box still shows once signed. Only
 * field names, counts and page numbers are printed, never a signer's name.
 * Run it from the project root (the appearance font is read from public/).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: npm run pdf:sign-check -- <file.pdf> [<file.pdf> ...]');
  process.exit(2);
}
const lib = (name) => pathToFileURL(path.join(process.cwd(), 'lib', 'pdfSign', name)).href;
const { loadPdfForSigning } = await import(lib('analyze.ts'));
const { widgetSnapshot } = await import(lib('widgets.ts'));
const { createSoftIdentity, signWithIdentity } = await import(lib('testHelpers.ts'));

const identity = createSoftIdentity();
let failures = 0;
for (const file of files) {
  console.log(`\n${path.basename(file)}`);
  try {
    const pdf = readFileSync(file);
    const { analysis } = await loadPdfForSigning(pdf);
    const before = await widgetSnapshot(pdf);
    const boxes = before.widgets.filter((widget) => widget.type === 'Sig');
    const shown = boxes.filter((widget) => widget.visible && widget.hasAppearance).length;
    console.log(
      `  pages ${analysis.pageCount}, signatures ${analysis.signatureCount}, ` +
        `signature boxes ${boxes.length} (${shown} shown), other form widgets ${before.widgets.length - boxes.length}`
    );
    console.log(
      `  pdf-lib vs xref: ${
        analysis.realignedObjects === 0
          ? 'same'
          : `${analysis.realignedObjects} object(s) differ -- the xref version is used`
      }`
    );
    // finalize refuses the result if any earlier box no longer shows.
    const { prepared } = await signWithIdentity(pdf, identity);
    console.log(`  new field ${prepared.expected.widgets.field}: every earlier box still shows`);
  } catch (error) {
    failures += 1;
    console.log(`  NOT OK: ${error?.code ?? error?.name ?? 'error'} ${error?.message ?? ''}`);
  }
}
process.exit(failures === 0 ? 0 : 1);
