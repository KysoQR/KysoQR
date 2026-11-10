import { createHash } from 'node:crypto';
import fontkit from '@pdf-lib/fontkit';
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFContext,
  type PDFImage,
  type PDFObject,
} from 'pdf-lib';
import {
  assertSignable,
  type ExpectedAfter,
  loadPdfForSigning,
  type PdfAnalysis,
} from './analyze.ts';
import { type AppearanceContent, type AppearanceFonts, createAppearance } from './appearance.ts';
import { buildSignedAttributes, estimateCmsSize } from './cms.ts';
import { PdfSignError } from './errors.ts';
import { assertFewByteRanges } from './rawPdf.ts';
import { loadAppearanceFonts, loadAppearanceImages } from './fonts.ts';
import {
  appearanceMatrix,
  type FieldPlacement,
  type PageGeometry,
  pageGeometry,
  placeBox,
} from './geometry.ts';
import {
  assertAppendedUpdateIsExact,
  buildIncrementalUpdate,
  type UpdateObject,
} from './incremental.ts';
import {
  DEFAULT_CONTENTS_BYTES,
  MAX_CHAIN_CERTS,
  MAX_CONTENTS_BYTES,
  MAX_DETAIL_CHARS,
  MAX_DETAIL_LINES,
  MAX_FIELDS,
  MAX_NAME_CHARS,
} from './limits.ts';
import { loadCertificate, rsaModulusBytes } from './rsa.ts';
import { sanitizeDisplayText } from './text.ts';
import { widgetFieldNames, widgetSnapshot } from './widgets.ts';

/**
 * Phase 1 of a signature: turns the PDF into "original + appended update"
 * that already carries the signature field, its visible appearance and a
 * zero-filled /Contents placeholder, and works out what the signer must sign.
 *
 * It is an INCREMENTAL UPDATE: the original bytes are kept exactly as they
 * were and only new or changed objects, a new xref section and the trailer
 * are appended. Re-saving the whole file (what pdf-lib's save() does) would
 * break every signature already in it. pdf-lib is only used to read the
 * existing structure and to build the new objects (widget, appearance,
 * embedded font); the update itself is written by incremental.ts.
 *
 * The signature goes into the file later, in finalizePdf(), possibly minutes
 * after this returns and in another process: everything finalize needs is in
 * the result (and is meant to be stored by the caller, encrypted).
 */

export type { FieldPlacement } from './geometry.ts';
export type { AppearanceContent } from './appearance.ts';

export interface PrepareInput {
  pdf: Buffer;
  /** Boxes where the (single) signature is shown; at least one. */
  fields: FieldPlacement[];
  /** What the visible signature shows (signer name + details). */
  appearance: AppearanceContent;
  signingTime: Date;
  /** Signer certificate, DER. */
  certificateDer: Buffer;
  /** CA certificates that will be embedded after it (only used to size /Contents). */
  chainDer: Buffer[];
  /** Extra room in /Contents for a timestamp token added at finalize (bytes). */
  timestampReserveBytes?: number | undefined;
}

export interface PrepareResult {
  /** Bytes to append after the original: changed objects, xref, trailer. */
  tail: Buffer;
  originalLength: number;
  /** Final /ByteRange of the signature (offsets in original + tail). */
  byteRange: [number, number, number, number];
  /** Offset of the `<` that opens the /Contents hex string. */
  contentsOffset: number;
  /** Length of /Contents including `<` and `>`. */
  contentsLength: number;
  /** SHA-256 of the bytes /ByteRange covers (CMS messageDigest). */
  contentDigest: Buffer;
  /** DER SET of the signed attributes: exactly what the signer signs. */
  signedAttrsDer: Buffer;
  /** SHA-256(signedAttrsDer): the digestValue to send to CSign. */
  digestToSign: Buffer;
  /** The file as it was (before the update). */
  analysis: PdfAnalysis;
  /** What the file must look like after the update; finalize checks the result against it. */
  expected: ExpectedAfter;
}

const BYTE_RANGE_PLACEHOLDER = '[0 0000000000 0000000000 0000000000]';
/**
 * Entries every signature KysoQR builds carries, the same as the ones CAS
 * writes, so Adobe's signature panel reads alike for both. Fixed ASCII without
 * parentheses or backslashes: safe as literal strings, nothing user-chosen.
 */
const SIGNATURE_REASON = 'eSign document signature';
const SIGNATURE_CONTACT_INFO = 'N/A';
const SIGNATURE_LOCATION = 'VN';
const ascii = (text: string) => Buffer.from(text, 'latin1');
const refKey = (ref: PDFRef) => `${ref.objectNumber} ${ref.generationNumber}`;

function serialize(object: PDFObject): Buffer {
  const buffer = Buffer.alloc(object.sizeInBytes());
  object.copyBytesInto(buffer, 0);
  return buffer;
}

function pdfDate(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

/** `[0 a b c]` padded with spaces to the placeholder's exact length. */
function byteRangeText(range: readonly number[]): string {
  const inner = range.join(' ');
  const text = `[${inner.padEnd(BYTE_RANGE_PLACEHOLDER.length - 2)}]`;
  if (text.length !== BYTE_RANGE_PLACEHOLDER.length) {
    throw new PdfSignError('JOB_FAILED', 'byte range does not fit its placeholder');
  }
  return text;
}

function validateInput(input: PrepareInput, pageCount: number): AppearanceContent {
  if (input.fields.length < 1 || input.fields.length > MAX_FIELDS) {
    throw new PdfSignError('FIELD_INVALID', `a signature needs 1 to ${MAX_FIELDS} boxes`);
  }
  for (const field of input.fields) {
    if (!Number.isInteger(field.page) || field.page < 1 || field.page > pageCount) {
      throw new PdfSignError('FIELD_INVALID', `page ${field.page} does not exist`);
    }
  }
  if (Number.isNaN(input.signingTime.getTime()))
    throw new PdfSignError('FIELD_INVALID', 'signing time is invalid');
  if (input.chainDer.length > MAX_CHAIN_CERTS) {
    throw new PdfSignError('CMS_INVALID', `certificate chain longer than ${MAX_CHAIN_CERTS}`);
  }
  const name = sanitizeDisplayText(input.appearance.name, MAX_NAME_CHARS);
  if (!name) throw new PdfSignError('FIELD_INVALID', 'the signature needs a signer name');
  const details = input.appearance.details
    .slice(0, MAX_DETAIL_LINES)
    .map((line) => sanitizeDisplayText(line, MAX_DETAIL_CHARS))
    .filter(Boolean);
  const logoCaption = sanitizeDisplayText(input.appearance.logoCaption ?? '', MAX_DETAIL_CHARS);
  const note = sanitizeDisplayText(input.appearance.note ?? '', MAX_DETAIL_CHARS);
  return { name, details, ...(logoCaption ? { logoCaption } : {}), ...(note ? { note } : {}) };
}

/** Fully qualified name of every node of the form's field tree. */
function formFieldNames(context: PDFContext, catalog: PDFDict): Set<string> {
  const names = new Set<string>();
  const acroForm = catalog.lookup(PDFName.of('AcroForm'));
  const fields = acroForm instanceof PDFDict ? acroForm.lookup(PDFName.of('Fields')) : undefined;
  if (!(fields instanceof PDFArray)) return names;
  const stack = fields.asArray().map((value) => ({ value, prefix: '', depth: 0 }));
  const seen = new Set<PDFDict>();
  while (stack.length > 0 && seen.size < 10_000) {
    const { value, prefix, depth } = stack.pop()!;
    const field = value instanceof PDFRef ? context.lookup(value) : value;
    if (!(field instanceof PDFDict) || seen.has(field) || depth > 32) continue;
    seen.add(field);
    const partial = field.lookup(PDFName.of('T'));
    const text =
      partial instanceof PDFString || partial instanceof PDFHexString ? partial.decodeText() : '';
    const full = text && prefix ? `${prefix}.${text}` : text || prefix;
    if (full) names.add(full);
    const kids = field.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) {
      for (const kid of kids.asArray()) stack.push({ value: kid, prefix: full, depth: depth + 1 });
    }
  }
  return names;
}

/**
 * `Signature<n>` with the smallest n no field of the document uses -- the
 * name CAS and Adobe give signature fields. It must be unique in the whole
 * document, not just among the top-level fields: viewers merge fields that
 * share a name, and one of the two signature boxes then stops showing.
 */
function freeSignatureFieldName(taken: Set<string>): string {
  let number = 1;
  while (taken.has(`Signature${number}`)) number += 1;
  return `Signature${number}`;
}

/** Adds `widget` to the page's /Annots, copying every annotation already there. */
function addAnnotation(
  context: PDFContext,
  pageNode: PDFDict,
  pageRef: PDFRef,
  widget: PDFRef,
  modified: Map<string, PDFRef>
) {
  const annotsKey = PDFName.of('Annots');
  const raw = pageNode.get(annotsKey);
  if (raw instanceof PDFRef) {
    const array = context.lookupMaybe(raw, PDFArray);
    if (!array) throw new PdfSignError('PDF_UNSUPPORTED', 'page /Annots is not an array');
    array.push(widget);
    modified.set(refKey(raw), raw);
  } else if (raw instanceof PDFArray) {
    raw.push(widget);
    modified.set(refKey(pageRef), pageRef);
  } else if (raw === undefined) {
    pageNode.set(annotsKey, context.obj([widget]));
    modified.set(refKey(pageRef), pageRef);
  } else {
    throw new PdfSignError('PDF_UNSUPPORTED', 'page /Annots is not an array');
  }
}

export async function preparePdf(input: PrepareInput): Promise<PrepareResult> {
  const original = input.pdf;
  // Not in loadPdfForSigning: finalize reloads the signed file, one more.
  assertFewByteRanges(original);
  const { doc, analysis, baselineObjectNumber } = await loadPdfForSigning(original);
  assertSignable(analysis);
  const pageCount = analysis.pageCount;
  // The widgets as a viewer shows them, to check the signed file against.
  const widgetsBefore = await widgetSnapshot(original);
  if (widgetsBefore.pageCount !== pageCount) {
    throw new PdfSignError('PDF_UNSUPPORTED', 'the page count depends on how the PDF is read');
  }
  const content = validateInput(input, pageCount);

  const certificate = loadCertificate(input.certificateDer);
  const modulusBytes = rsaModulusBytes(certificate);
  if (!modulusBytes) throw new PdfSignError('CMS_INVALID', 'signer key is not RSA');
  const reserve = input.timestampReserveBytes ?? 0;
  if (!Number.isSafeInteger(reserve) || reserve < 0) {
    throw new PdfSignError('FIELD_INVALID', 'timestamp reserve is not a byte count');
  }
  const needed =
    estimateCmsSize(input.certificateDer, input.chainDer, modulusBytes) + 512 + reserve;
  const contentsBytes = Math.max(DEFAULT_CONTENTS_BYTES, Math.ceil(needed / 1024) * 1024);
  if (contentsBytes > MAX_CONTENTS_BYTES) {
    throw new PdfSignError('SIGNATURE_TOO_LARGE', 'the certificate chain is too large to embed');
  }

  const context = doc.context;
  const rootRef = context.trailerInfo.Root as PDFRef; // checked by loadPdfForSigning
  const modified = new Map<string, PDFRef>();

  doc.registerFontkit(fontkit);
  const fontBytes = loadAppearanceFonts();
  const fonts: AppearanceFonts = {
    regular: await doc.embedFont(fontBytes.regular, { subset: true }),
  };
  // VNeID's look: the name in semibold and VNeID's logo, embedded once for every box.
  let logo: PDFImage | undefined;
  if (content.logoCaption) {
    fonts.bold = await doc.embedFont(fontBytes.semibold, { subset: true });
    logo = await doc.embedPng(loadAppearanceImages().vneidLogo);
  }

  // --- one signature field; one widget per box ---------------------------------
  // A single box: the field and its widget are the same dictionary. Several
  // boxes: one field (/FT /Sig, /V) whose /Kids are the widgets, so the
  // document carries ONE signature shown in every box.
  const signatureRef = context.nextRef();
  const fieldNameText = freeSignatureFieldName(
    new Set([
      ...formFieldNames(context, context.lookup(rootRef, PDFDict)),
      ...widgetFieldNames(widgetsBefore),
    ])
  );
  const fieldName = PDFString.of(fieldNameText);
  const single = input.fields.length === 1;
  const parentRef = single ? undefined : context.nextRef();
  const widgets: PDFRef[] = [];
  const geometry = new Map<number, PageGeometry>();

  for (const field of input.fields) {
    const page = doc.getPage(field.page - 1);
    let pageGeom = geometry.get(field.page);
    if (!pageGeom) {
      pageGeom = pageGeometry(page);
      geometry.set(field.page, pageGeom);
    }
    const box = placeBox(pageGeom, field);
    const appearance = createAppearance(
      context,
      fonts,
      box.width,
      box.height,
      content,
      appearanceMatrix(pageGeom.rotation),
      logo?.ref
    );
    const widget = context.register(
      context.obj({
        Type: 'Annot',
        Subtype: 'Widget',
        Rect: box.rect,
        F: 4,
        P: page.ref,
        AP: { N: appearance },
        ...(single ? { FT: 'Sig', V: signatureRef, T: fieldName } : { Parent: parentRef }),
      })
    );
    widgets.push(widget);
    addAnnotation(context, page.node, page.ref, widget, modified);
  }
  if (parentRef) {
    context.assign(
      parentRef,
      context.obj({ FT: 'Sig', V: signatureRef, T: fieldName, Kids: widgets })
    );
  }
  const formField = parentRef ?? widgets[0]!;
  // Glyphs are subset at embed time, so only after every encodeText().
  await fonts.regular.embed();
  await fonts.bold?.embed();
  await logo?.embed();

  // --- catalog /AcroForm: append to /Fields, keep everything else ------------------
  const catalog = context.lookup(rootRef, PDFDict);
  const acroKey = PDFName.of('AcroForm');
  const acroRaw = catalog.get(acroKey);
  let acroForm: PDFDict;
  let acroOwner: PDFRef;
  if (acroRaw instanceof PDFRef) {
    const dict = context.lookupMaybe(acroRaw, PDFDict);
    if (!dict) throw new PdfSignError('PDF_UNSUPPORTED', '/AcroForm is not a dictionary');
    acroForm = dict;
    acroOwner = acroRaw;
  } else if (acroRaw instanceof PDFDict) {
    acroForm = acroRaw;
    acroOwner = rootRef;
  } else if (acroRaw === undefined) {
    acroForm = context.obj({});
    catalog.set(acroKey, acroForm);
    acroOwner = rootRef;
  } else {
    throw new PdfSignError('PDF_UNSUPPORTED', '/AcroForm is not a dictionary');
  }
  const fieldsKey = PDFName.of('Fields');
  const fieldsRaw = acroForm.get(fieldsKey);
  if (fieldsRaw instanceof PDFRef) {
    const array = context.lookupMaybe(fieldsRaw, PDFArray);
    if (!array) throw new PdfSignError('PDF_UNSUPPORTED', '/AcroForm /Fields is not an array');
    array.push(formField);
    modified.set(refKey(fieldsRaw), fieldsRaw);
  } else if (fieldsRaw instanceof PDFArray) {
    fieldsRaw.push(formField);
    modified.set(refKey(acroOwner), acroOwner);
  } else if (fieldsRaw === undefined) {
    acroForm.set(fieldsKey, context.obj([formField]));
    modified.set(refKey(acroOwner), acroOwner);
  } else {
    throw new PdfSignError('PDF_UNSUPPORTED', '/AcroForm /Fields is not an array');
  }
  const flagsKey = PDFName.of('SigFlags');
  const flagsRaw = acroForm.lookup(flagsKey);
  const flags = flagsRaw instanceof PDFNumber ? flagsRaw.asNumber() : 0;
  // SignaturesExist (1) | AppendOnly (2); keeps whatever else was set.
  acroForm.set(flagsKey, PDFNumber.of(Number.isInteger(flags) && flags >= 0 ? flags | 3 : 3));
  modified.set(refKey(acroOwner), acroOwner);

  // --- the objects to append ----------------------------------------------------
  const objects = new Map<number, UpdateObject>();
  const add = (ref: PDFRef, object: PDFObject) => {
    objects.set(ref.objectNumber, {
      number: ref.objectNumber,
      generation: ref.generationNumber,
      body: serialize(object),
    });
  };
  for (let number = baselineObjectNumber + 1; number <= context.largestObjectNumber; number += 1) {
    const ref = PDFRef.of(number, 0);
    const object = context.lookup(ref);
    if (object) add(ref, object);
  }
  for (const ref of modified.values()) {
    const object = context.lookup(ref);
    if (object) add(ref, object);
  }
  const signatureDict =
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached ` +
    `/ByteRange ${BYTE_RANGE_PLACEHOLDER} /Contents <${'0'.repeat(contentsBytes * 2)}> ` +
    `/Reason (${SIGNATURE_REASON}) /M (${pdfDate(input.signingTime)}) ` +
    `/ContactInfo (${SIGNATURE_CONTACT_INFO}) ` +
    `/Name ${PDFHexString.fromText(content.name).toString()} /Location (${SIGNATURE_LOCATION}) ` +
    `/Prop_Build << /Filter << /Name /Adobe.PPKLite >> >> >>`;
  objects.set(signatureRef.objectNumber, {
    number: signatureRef.objectNumber,
    generation: 0,
    body: ascii(signatureDict),
  });

  const lastByte = original[original.length - 1];
  const update = buildIncrementalUpdate({
    originalLength: original.length,
    needsSeparator: lastByte !== 0x0a && lastByte !== 0x0d,
    objects: [...objects.values()],
    kind: analysis.xrefKind,
    prevStartXref: analysis.prevStartXref,
    nextObjectNumber: context.largestObjectNumber + 1,
    trailer: {
      root: rootRef.toString(),
      info: context.trailerInfo.Info?.toString(),
      id: context.trailerInfo.ID?.toString(),
    },
  });
  const tail = update.tail;

  // --- fill /ByteRange, hash what it covers -------------------------------------
  // The signature object is ours and nothing user-influenced precedes these two
  // markers in it, so the first match after its offset is the right one.
  const signatureAt = update.objectOffsets.get(signatureRef.objectNumber)!;
  const byteRangeAt = tail.indexOf(BYTE_RANGE_PLACEHOLDER, signatureAt, 'latin1');
  const contentsKeyAt = tail.indexOf('/Contents <', signatureAt, 'latin1');
  if (byteRangeAt < 0 || contentsKeyAt < 0)
    throw new PdfSignError('JOB_FAILED', 'signature placeholders not found');
  const contentsInTail = contentsKeyAt + '/Contents '.length;
  const contentsLength = contentsBytes * 2 + 2;
  const contentsOffset = original.length + contentsInTail;
  const contentsEnd = contentsOffset + contentsLength;
  const byteRange: [number, number, number, number] = [
    0,
    contentsOffset,
    contentsEnd,
    original.length + tail.length - contentsEnd,
  ];
  tail.write(byteRangeText(byteRange), byteRangeAt, 'latin1');

  const contentDigest = createHash('sha256')
    .update(original)
    .update(tail.subarray(0, contentsInTail))
    .update(tail.subarray(contentsInTail + contentsLength))
    .digest();
  const signedAttrs = buildSignedAttributes(contentDigest, input.certificateDer);

  assertAppendedUpdateIsExact(tail, original.length, analysis.xrefKind, analysis.prevStartXref);

  const pageAnnotCounts = [...analysis.pageAnnotCounts];
  for (const field of input.fields)
    pageAnnotCounts[field.page - 1] = (pageAnnotCounts[field.page - 1] ?? 0) + 1;

  return {
    tail,
    originalLength: original.length,
    byteRange,
    contentsOffset,
    contentsLength,
    contentDigest,
    signedAttrsDer: signedAttrs.der,
    digestToSign: signedAttrs.digest,
    analysis,
    expected: {
      pageCount: analysis.pageCount,
      signatureCount: analysis.signatureCount + 1,
      acroFormFieldCount: analysis.acroFormFieldCount + 1,
      pageAnnotCounts,
      widgets: {
        before: widgetsBefore,
        field: fieldNameText,
        pages: input.fields.map((field) => field.page),
      },
    },
  };
}
