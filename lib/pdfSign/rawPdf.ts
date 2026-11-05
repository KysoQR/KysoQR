import { inflateSync } from 'node:zlib';
import { PdfSignError } from './errors.ts';
import { MAX_OBJSTM_INFLATED_BYTES } from './limits.ts';

/**
 * Byte-level helpers that run BEFORE pdf-lib touches an untrusted file.
 * pdf-lib parses by scanning objects from the top of the file (it never reads
 * the xref offsets) and inflates every object stream with no size cap, so the
 * structural facts an incremental update needs -- where the previous xref
 * section is, whether it is a table or a stream, what /Size it declared --
 * and the decompression-bomb check are done here, on the raw bytes.
 */

export type XrefKind = 'table' | 'stream';

export interface XrefSection {
  kind: XrefKind;
  /** The /Size the section's trailer (or xref stream dictionary) declares. */
  size: number;
}

/** Offset in `startxref` is at most 12 digits (a PDF is far below 10^12 bytes). */
const STARTXREF = /startxref[\0\t\n\f\r ]+(\d{1,12})/g;

export function assertPdfHeader(pdf: Buffer): void {
  if (pdf.length < 16 || pdf.toString('latin1', 0, 5) !== '%PDF-') {
    throw new PdfSignError('PDF_INVALID', 'missing %PDF- header at offset 0');
  }
}

/** The value of the LAST `startxref` in the final bytes of the file. */
export function findLastStartXref(pdf: Buffer): number {
  const tail = pdf.toString('latin1', Math.max(0, pdf.length - 4096));
  let last: RegExpMatchArray | undefined;
  for (const match of tail.matchAll(STARTXREF)) last = match;
  if (!last) throw new PdfSignError('PDF_UNSUPPORTED', 'no startxref near the end of the file');
  const offset = Number(last[1]);
  if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= pdf.length) {
    throw new PdfSignError('PDF_UNSUPPORTED', 'startxref points outside the file');
  }
  return offset;
}

/**
 * Describes (and sanity-checks) the xref section a `startxref` points at.
 * Not a full xref parse -- just enough to refuse a file whose last section is
 * not where it says, since an update's /Prev would then point into garbage.
 */
export function readXrefSection(pdf: Buffer, offset: number): XrefSection {
  // Some writers leave whitespace between the offset and the keyword.
  let start = offset;
  while (start < pdf.length && start < offset + 16 && isWhitespace(pdf[start]!)) start += 1;

  if (pdf.toString('latin1', start, start + 4) === 'xref') {
    const trailerAt = pdf.indexOf('trailer', start + 4, 'latin1');
    if (trailerAt < 0) throw new PdfSignError('PDF_UNSUPPORTED', 'xref table without a trailer');
    const entries = pdf.toString('latin1', start + 4, trailerAt);
    for (const raw of entries.split(/\r\n|\n|\r/)) {
      const line = raw.trim();
      if (line === '' || /^\d{1,10} \d{1,10}$/.test(line) || /^\d{10} \d{5} [nf]$/.test(line))
        continue;
      throw new PdfSignError('PDF_UNSUPPORTED', 'malformed xref table');
    }
    const trailer = pdf.toString('latin1', trailerAt, Math.min(pdf.length, trailerAt + 8192));
    const size = /\/Size[\0\t\n\f\r ]+(\d{1,10})/.exec(trailer);
    if (!size) throw new PdfSignError('PDF_UNSUPPORTED', 'trailer without /Size');
    return { kind: 'table', size: Number(size[1]) };
  }

  const head = pdf.toString('latin1', start, Math.min(pdf.length, start + 8192));
  if (/^\d{1,10}[\0\t\n\f\r ]+\d{1,5}[\0\t\n\f\r ]+obj/.test(head)) {
    const dictEnd = head.indexOf('stream');
    const dict = dictEnd > 0 ? head.slice(0, dictEnd) : head;
    if (!/\/Type[\0\t\n\f\r ]*\/XRef/.test(dict)) {
      throw new PdfSignError('PDF_UNSUPPORTED', 'startxref does not point at an xref stream');
    }
    const size = /\/Size[\0\t\n\f\r ]+(\d{1,10})/.exec(dict);
    if (!size) throw new PdfSignError('PDF_UNSUPPORTED', 'xref stream without /Size');
    return { kind: 'stream', size: Number(size[1]) };
  }
  throw new PdfSignError('PDF_UNSUPPORTED', 'startxref does not point at an xref section');
}

function isWhitespace(byte: number): boolean {
  return (
    byte === 0x00 ||
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0c ||
    byte === 0x0d ||
    byte === 0x20
  );
}

/** Regex source for a PDF name that may carry `#xx` escapes (`/ObjStm` can be
 * written `/#4fbjStm`; the parser decodes it, a naive search would not). */
function escapedName(name: string): string {
  return [...name]
    .map((char) => {
      const hex = char.charCodeAt(0).toString(16).padStart(2, '0');
      return `(?:${char}|#${hex})`;
    })
    .join('');
}

const OBJSTM_TYPE = new RegExp(
  `\\/${escapedName('Type')}[\\0\\t\\n\\f\\r ]*\\/${escapedName('ObjStm')}`,
  'gi'
);

/**
 * pdf-lib inflates every object stream when it loads a file and has no output
 * cap, so a few KB of zlib can ask for gigabytes. Inflate each one here with a
 * hard cap first; anything over it is refused before pdf-lib sees the file.
 * (The runner's memory watchdog is the backstop for what this cannot see.)
 */
export function assertNoObjectStreamBomb(pdf: Buffer): void {
  const text = pdf.toString('latin1');
  let total = 0;
  for (const match of text.matchAll(OBJSTM_TYPE)) {
    const typeAt = match.index;
    const objAt = text.lastIndexOf(' obj', typeAt);
    const streamAt = text.indexOf('stream', typeAt);
    if (objAt < 0 || streamAt < 0 || text[streamAt - 1] === 'd') continue;

    const dict = text.slice(objAt, streamAt);
    // pdf-lib decodes whatever chain /Filter names; only a lone Flate is
    // something this check can bound, so refuse every other chain.
    const filter = /\/Filter[\0\t\n\f\r ]*(\[[^\]]*\]|\/[^\s/<>[\]()]+)/.exec(dict)?.[1];
    if (filter !== undefined && !/^\/(?:FlateDecode|Fl)$/.test(filter)) {
      throw new PdfSignError('PDF_UNSUPPORTED', 'object stream uses an unsupported filter chain');
    }

    let dataStart = streamAt + 'stream'.length;
    if (text[dataStart] === '\r' && text[dataStart + 1] === '\n') dataStart += 2;
    else if (text[dataStart] === '\n' || text[dataStart] === '\r') dataStart += 1;
    else continue;
    const dataEnd = text.indexOf('endstream', dataStart);
    if (dataEnd < 0) continue;
    if (filter === undefined) {
      total += dataEnd - dataStart;
    } else {
      try {
        total += inflateSync(pdf.subarray(dataStart, dataEnd), {
          maxOutputLength: MAX_OBJSTM_INFLATED_BYTES,
        }).length;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new PdfSignError('PDF_UNSUPPORTED', 'object stream inflates beyond the limit');
        }
        // Corrupt or truncated data: pdf-lib will reject the file by itself.
      }
    }
    if (total > MAX_OBJSTM_INFLATED_BYTES * 2) {
      throw new PdfSignError('PDF_UNSUPPORTED', 'object streams inflate beyond the limit');
    }
  }
}
