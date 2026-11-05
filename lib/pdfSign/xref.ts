import { constants, inflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFObjectParser,
  PDFRawStream,
  PDFRef,
  type PDFObject,
} from 'pdf-lib';
import { MAX_OBJSTM_INFLATED_BYTES, MAX_PAGES } from './limits.ts';

/**
 * The file as a PDF viewer reads it: through its cross-reference sections,
 * newest first (the last startxref, then /Prev, and /XRefStm in hybrid files).
 *
 * pdf-lib does not do this. It scans the file from the top, keeps the LAST
 * definition it meets of each object and quietly skips what it cannot parse.
 * Most of the time that is the same thing. When it is not -- an object written
 * again after the last xref section, an update another tool wrote badly, an
 * object pdf-lib misreads -- the page or the form pdf-lib hands us is not the
 * one Adobe or Chrome shows, and an update built from it drops whatever the
 * newer version holds: typically the widget of an earlier signature, which
 * then no longer appears on the page although it is still in the file.
 *
 * alignWithXref() therefore puts the viewer's version of every object an
 * update reads or rewrites (catalog, page tree, pages, their annotations and
 * widgets, the form and its field tree) into pdf-lib's context before anything
 * else looks at it. When the xref data itself cannot be followed, a viewer
 * rebuilds it by scanning the file -- which is what pdf-lib did -- so its view
 * is kept as is.
 */

export type XrefEntry =
  | { kind: 'free' }
  | { kind: 'offset'; offset: number; generation: number }
  | { kind: 'compressed'; stream: number; index: number };

export interface XrefChain {
  /** The newest entry of every object number the sections list. */
  entries: Map<number, XrefEntry>;
  /** The newest trailer (or xref stream dictionary). */
  trailer: PDFDict;
  sections: number;
}

/** The xref data cannot be followed: a viewer would rebuild it by scanning. */
export class XrefUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XrefUnusableError';
  }
}

const MAX_SECTIONS = 1000;
/** A row is three fields of at most 8 bytes; far more than a MAX_PDF_BYTES file can index. */
const MAX_XREF_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_ALIGNED_OBJECTS = 50_000;
const MAX_TREE_DEPTH = 64;

const unusable = (message: string) => new XrefUnusableError(message);
const name = (value: string) => PDFName.of(value);
const HEADER = /^[\0\t\n\f\r ]*(\d{1,10})[\0\t\n\f\r ]+(\d{1,5})[\0\t\n\f\r ]+obj(?![A-Za-z0-9])/;

function numberIn(dict: PDFDict, key: string): number | undefined {
  const value = dict.get(name(key));
  if (!(value instanceof PDFNumber)) return undefined;
  const number = value.asNumber();
  return Number.isSafeInteger(number) ? number : undefined;
}

function numbersIn(value: PDFObject | undefined): number[] | undefined {
  if (!(value instanceof PDFArray)) return undefined;
  const numbers: number[] = [];
  for (const item of value.asArray()) {
    if (!(item instanceof PDFNumber) || !Number.isSafeInteger(item.asNumber())) return undefined;
    numbers.push(item.asNumber());
  }
  return numbers;
}

function parseAt(bytes: Uint8Array, at: number, context: PDFContext): PDFObject {
  return PDFObjectParser.forBytes(bytes.subarray(at), context).parseObject();
}

function headerAt(pdf: Buffer, offset: number) {
  const match = HEADER.exec(pdf.toString('latin1', offset, Math.min(pdf.length, offset + 48)));
  return match
    ? { number: Number(match[1]), generation: Number(match[2]), bodyAt: offset + match[0].length }
    : undefined;
}

/** Undoes the PNG predictors (one byte per pixel, as xref streams use them). */
function undoPngPredictor(data: Buffer, columns: number): Buffer {
  if (!Number.isSafeInteger(columns) || columns < 1 || columns > 64) {
    throw unusable('xref stream /Columns is out of range');
  }
  const rows = Math.floor(data.length / (columns + 1));
  const out = Buffer.alloc(rows * columns);
  for (let row = 0; row < rows; row += 1) {
    const filter = data[row * (columns + 1)]!;
    const from = row * (columns + 1) + 1;
    const to = row * columns;
    for (let column = 0; column < columns; column += 1) {
      const raw = data[from + column]!;
      const left = column > 0 ? out[to + column - 1]! : 0;
      const up = row > 0 ? out[to - columns + column]! : 0;
      const upLeft = row > 0 && column > 0 ? out[to - columns + column - 1]! : 0;
      let value: number;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + ((left + up) >> 1);
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const toLeft = Math.abs(estimate - left);
        const toUp = Math.abs(estimate - up);
        const toUpLeft = Math.abs(estimate - upLeft);
        value =
          raw + (toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft);
      } else throw unusable('xref stream has an unknown PNG predictor row');
      out[to + column] = value & 0xff;
    }
  }
  return out;
}

/** The Flate stream data of an xref or object stream, inflated with a cap. */
function inflated(stream: PDFRawStream, maxBytes: number, allowPredictor: boolean): Buffer {
  let filter = stream.dict.get(name('Filter'));
  let parms = stream.dict.get(name('DecodeParms'));
  if (filter instanceof PDFArray) {
    if (filter.size() > 1) throw unusable('stream uses a filter chain');
    filter = filter.size() === 1 ? filter.get(0) : undefined;
    parms = parms instanceof PDFArray ? parms.get(0) : parms;
  }
  let data = Buffer.from(stream.contents);
  if (filter !== undefined) {
    if (filter !== name('FlateDecode')) throw unusable('stream is not Flate encoded');
    try {
      data = inflateSync(data, { maxOutputLength: maxBytes, finishFlush: constants.Z_SYNC_FLUSH });
    } catch {
      throw unusable('stream does not inflate');
    }
  }
  if (!(parms instanceof PDFDict)) return data;
  const predictor = numberIn(parms, 'Predictor') ?? 1;
  if (predictor === 1) return data;
  const colors = numberIn(parms, 'Colors') ?? 1;
  const bits = numberIn(parms, 'BitsPerComponent') ?? 8;
  if (!allowPredictor || predictor < 10 || colors !== 1 || bits !== 8) {
    throw unusable('stream uses an unsupported predictor');
  }
  return undoPngPredictor(data, numberIn(parms, 'Columns') ?? 1);
}

interface Section {
  kind: 'table' | 'stream';
  entries: [number, XrefEntry][];
  trailer: PDFDict;
}

function readTable(pdf: Buffer, at: number, context: PDFContext): Section {
  const trailerAt = pdf.indexOf('trailer', at, 'latin1');
  if (trailerAt < 0) throw unusable('xref table without a trailer');
  const entries: [number, XrefEntry][] = [];
  let next = 0;
  let left = 0;
  for (const raw of pdf.toString('latin1', at + 4, trailerAt).split(/\r\n|\n|\r/)) {
    const line = raw.trim();
    if (line === '') continue;
    const head = left === 0 ? /^(\d{1,10}) (\d{1,10})$/.exec(line) : null;
    if (head) {
      next = Number(head[1]);
      left = Number(head[2]);
      continue;
    }
    const entry = /^(\d{10}) (\d{5}) ([nf])$/.exec(line);
    if (!entry || left === 0) throw unusable('malformed xref table');
    entries.push([
      next,
      entry[3] === 'n'
        ? { kind: 'offset', offset: Number(entry[1]), generation: Number(entry[2]) }
        : { kind: 'free' },
    ]);
    next += 1;
    left -= 1;
  }
  if (left !== 0) throw unusable('xref subsection is shorter than it says');
  const trailer = parseAt(pdf, trailerAt + 'trailer'.length, context);
  if (!(trailer instanceof PDFDict)) throw unusable('trailer is not a dictionary');
  return { kind: 'table', entries, trailer };
}

function readStreamSection(pdf: Buffer, at: number, context: PDFContext): Section {
  const header = headerAt(pdf, at);
  if (!header) throw unusable('xref offset does not point at an object');
  const stream = parseAt(pdf, header.bodyAt, context);
  if (!(stream instanceof PDFRawStream) || stream.dict.get(name('Type')) !== name('XRef')) {
    throw unusable('xref offset does not point at an xref stream');
  }
  const widths = numbersIn(stream.dict.get(name('W')));
  if (!widths || widths.length !== 3 || widths.some((width) => width < 0 || width > 8)) {
    throw unusable('xref stream /W is malformed');
  }
  const [typeWidth, secondWidth, thirdWidth] = widths as [number, number, number];
  const size = numberIn(stream.dict, 'Size');
  if (size === undefined) throw unusable('xref stream without /Size');
  const index = numbersIn(stream.dict.get(name('Index'))) ?? [0, size];
  if (index.length % 2 !== 0) throw unusable('xref stream /Index is malformed');

  const data = inflated(stream, MAX_XREF_STREAM_BYTES, true);
  const rowWidth = typeWidth + secondWidth + thirdWidth;
  if (rowWidth === 0) throw unusable('xref stream rows are empty');
  let position = 0;
  const field = (width: number, fallback: number) => {
    if (width === 0) return fallback;
    let value = 0;
    for (let i = 0; i < width; i += 1) value = value * 256 + data[position++]!;
    return value;
  };
  const entries: [number, XrefEntry][] = [];
  for (let i = 0; i < index.length; i += 2) {
    const first = index[i]!;
    const count = index[i + 1]!;
    for (let n = 0; n < count; n += 1) {
      if (position + rowWidth > data.length) throw unusable('xref stream is shorter than /Index');
      const type = field(typeWidth, 1);
      const second = field(secondWidth, 0);
      const third = field(thirdWidth, 0);
      entries.push([
        first + n,
        type === 1
          ? { kind: 'offset', offset: second, generation: third }
          : type === 2
            ? { kind: 'compressed', stream: second, index: third }
            : { kind: 'free' },
      ]);
    }
  }
  return { kind: 'stream', entries, trailer: stream.dict };
}

const WHITESPACE_BYTES = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

function readSection(pdf: Buffer, offset: number, context: PDFContext): Section {
  let at = offset;
  while (at < pdf.length && at < offset + 16 && WHITESPACE_BYTES.has(pdf[at]!)) at += 1;
  try {
    return pdf.toString('latin1', at, at + 4) === 'xref'
      ? readTable(pdf, at, context)
      : readStreamSection(pdf, at, context);
  } catch (error) {
    if (error instanceof XrefUnusableError) throw error;
    throw unusable('xref section cannot be parsed');
  }
}

/** Every xref section from `startxref` back to the first, merged newest first. */
export function readXrefChain(pdf: Buffer, startxref: number): XrefChain {
  // A scratch context: only trailers and xref stream dictionaries go into it.
  const context = PDFContext.create();
  const entries = new Map<number, XrefEntry>();
  let trailer: PDFDict | undefined;
  const queue = [{ offset: startxref, followPrev: true }];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const { offset, followPrev } = queue.shift()!;
    if (!Number.isSafeInteger(offset) || offset <= 0 || offset >= pdf.length) {
      throw unusable('xref offset points outside the file');
    }
    if (seen.has(offset)) throw unusable('xref sections form a loop');
    if (seen.size >= MAX_SECTIONS) throw unusable('too many xref sections');
    seen.add(offset);
    const section = readSection(pdf, offset, context);
    for (const [number, entry] of section.entries) {
      if (!entries.has(number)) entries.set(number, entry);
    }
    trailer ??= section.trailer;
    // A hybrid file's /XRefStm comes right after its table and before /Prev;
    // the stream's own /Prev is not followed: the table's /Prev leads on.
    const next: { offset: number; followPrev: boolean }[] = [];
    const xrefStm = section.kind === 'table' ? numberIn(section.trailer, 'XRefStm') : undefined;
    if (xrefStm !== undefined) next.push({ offset: xrefStm, followPrev: false });
    const prev = followPrev ? numberIn(section.trailer, 'Prev') : undefined;
    if (prev !== undefined) next.push({ offset: prev, followPrev: true });
    queue.unshift(...next);
  }
  return { entries, trailer: trailer!, sections: seen.size };
}

interface ObjectStream {
  data: Buffer;
  first: number;
  numbers: number[];
  offsets: number[];
}

/** Resolves references the way a viewer does, parsing into `context`. */
export class XrefReader {
  readonly chain: XrefChain;
  readonly #pdf: Buffer;
  readonly #context: PDFContext;
  readonly #objectStreams = new Map<number, ObjectStream>();

  constructor(pdf: Buffer, context: PDFContext, chain: XrefChain) {
    this.#pdf = pdf;
    this.#context = context;
    this.chain = chain;
  }

  /** The object `ref` names, or null when the xref marks it free or does not
   * list it. Throws XrefUnusableError when the entry cannot be followed. */
  resolve(ref: PDFRef): PDFObject | null {
    const entry = this.chain.entries.get(ref.objectNumber);
    if (!entry || entry.kind === 'free') return null;
    if (entry.kind === 'offset') {
      return entry.generation === ref.generationNumber
        ? this.#direct(ref.objectNumber, entry.offset, entry.generation)
        : null;
    }
    if (ref.generationNumber !== 0) return null;
    const stream = this.#objectStream(entry.stream);
    if (stream.numbers[entry.index] !== ref.objectNumber) {
      throw unusable(`object ${ref.objectNumber} is not where the xref puts it in its stream`);
    }
    const at = stream.first + stream.offsets[entry.index]!;
    if (at >= stream.data.length) throw unusable(`object ${ref.objectNumber} is past its stream`);
    try {
      return parseAt(stream.data, at, this.#context);
    } catch {
      throw unusable(`object ${ref.objectNumber} cannot be parsed`);
    }
  }

  #direct(number: number, offset: number, generation: number): PDFObject {
    if (offset <= 0 || offset >= this.#pdf.length) {
      throw unusable(`object ${number}: xref offset is outside the file`);
    }
    const header = headerAt(this.#pdf, offset);
    if (!header || header.number !== number || header.generation !== generation) {
      throw unusable(`object ${number}: xref offset does not point at it`);
    }
    try {
      return parseAt(this.#pdf, header.bodyAt, this.#context);
    } catch {
      throw unusable(`object ${number} cannot be parsed`);
    }
  }

  #objectStream(number: number): ObjectStream {
    const cached = this.#objectStreams.get(number);
    if (cached) return cached;
    const entry = this.chain.entries.get(number);
    if (!entry || entry.kind !== 'offset') throw unusable(`object stream ${number} is not listed`);
    const stream = this.#direct(number, entry.offset, entry.generation);
    if (!(stream instanceof PDFRawStream) || stream.dict.get(name('Type')) !== name('ObjStm')) {
      throw unusable(`object ${number} is not an object stream`);
    }
    const count = numberIn(stream.dict, 'N');
    const first = numberIn(stream.dict, 'First');
    if (count === undefined || first === undefined || count < 0 || count > 1_000_000 || first < 0) {
      throw unusable(`object stream ${number} has a malformed /N or /First`);
    }
    const data = inflated(stream, MAX_OBJSTM_INFLATED_BYTES, false);
    const head = data
      .toString('latin1', 0, Math.min(first, data.length))
      .trim()
      .split(/[\0\t\n\f\r ]+/)
      .map(Number);
    if (head.length < count * 2 || head.some((value) => !Number.isSafeInteger(value))) {
      throw unusable(`object stream ${number} has a malformed header`);
    }
    const parsed: ObjectStream = {
      data,
      first,
      numbers: head.filter((_, i) => i % 2 === 0).slice(0, count),
      offsets: head.filter((_, i) => i % 2 === 1).slice(0, count),
    };
    this.#objectStreams.set(number, parsed);
    return parsed;
  }
}

export interface Alignment {
  /** False when the xref data cannot be followed: pdf-lib's view is kept. */
  usable: boolean;
  /** Numbers of the objects whose pdf-lib version was replaced by the xref one. */
  replaced: number[];
}

function sameObject(a: PDFObject, b: PDFObject): boolean {
  if (a instanceof PDFRawStream || b instanceof PDFRawStream) {
    return (
      a instanceof PDFRawStream &&
      b instanceof PDFRawStream &&
      a.dict.toString() === b.dict.toString() &&
      Buffer.from(a.contents).equals(Buffer.from(b.contents))
    );
  }
  return a.toString() === b.toString();
}

const KEPT: Alignment = { usable: false, replaced: [] };

/**
 * Makes pdf-lib's `context` hold the version the xref points at for every
 * object an incremental update reads or rewrites. Call it before a
 * PDFDocument is built on the context (the document looks the catalog up once).
 * Nothing changes unless the whole walk succeeds.
 */
export function alignWithXref(pdf: Buffer, context: PDFContext, startxref: number): Alignment {
  let reader: XrefReader;
  try {
    reader = new XrefReader(pdf, context, readXrefChain(pdf, startxref));
  } catch (error) {
    if (error instanceof XrefUnusableError) return KEPT;
    throw error;
  }

  const pending = new Map<string, { ref: PDFRef; object: PDFObject }>();
  const visited = new Set<string>();
  /** What a viewer sees for `value` (a reference is followed); a version that
   * differs from pdf-lib's is recorded. */
  const view = (value: PDFObject | undefined): PDFObject | undefined => {
    if (!(value instanceof PDFRef)) return value;
    const key = `${value.objectNumber} ${value.generationNumber}`;
    const replacement = pending.get(key);
    if (replacement) return replacement.object;
    const mine = context.lookup(value);
    if (visited.has(key)) return mine;
    visited.add(key);
    if (visited.size > MAX_ALIGNED_OBJECTS) throw unusable('too many objects to compare');
    const viewer = reader.resolve(value);
    if (viewer === null || (mine !== undefined && sameObject(mine, viewer))) return mine;
    pending.set(key, { ref: value, object: viewer });
    return viewer;
  };
  const walk = (start: PDFObject[], visit: (node: PDFDict) => PDFObject[]) => {
    const stack = start.map((value) => ({ value, depth: 0 }));
    const seen = new Set<PDFDict>();
    while (stack.length > 0) {
      const { value, depth } = stack.pop()!;
      const node = view(value);
      if (!(node instanceof PDFDict) || seen.has(node)) continue;
      if (depth > MAX_TREE_DEPTH || seen.size > MAX_PAGES * 4) {
        throw unusable('tree is too deep or too large');
      }
      seen.add(node);
      for (const child of visit(node)) stack.push({ value: child, depth: depth + 1 });
    }
  };
  const arrayIn = (dict: PDFDict, key: string) => {
    const value = view(dict.get(name(key)));
    return value instanceof PDFArray ? value.asArray() : [];
  };

  let root: PDFRef;
  try {
    const rootValue = reader.chain.trailer.get(name('Root'));
    const catalog = view(rootValue);
    if (!(rootValue instanceof PDFRef) || !(catalog instanceof PDFDict)) return KEPT;
    root = rootValue;
    // Page tree -> pages -> annotations -> the parents of each widget.
    const pages = catalog.get(name('Pages'));
    walk(pages ? [pages] : [], (node) => {
      const kids = view(node.get(name('Kids')));
      if (kids instanceof PDFArray) return kids.asArray();
      for (const item of arrayIn(node, 'Annots')) {
        const annot = view(item);
        if (!(annot instanceof PDFDict) || annot.get(name('Subtype')) !== name('Widget')) continue;
        let parent = annot.get(name('Parent'));
        for (let depth = 0; parent instanceof PDFRef && depth < MAX_TREE_DEPTH; depth += 1) {
          const field = view(parent);
          if (!(field instanceof PDFDict)) break;
          parent = field.get(name('Parent'));
        }
      }
      return [];
    });
    // The form and its whole field tree.
    const acroForm = view(catalog.get(name('AcroForm')));
    if (acroForm instanceof PDFDict)
      walk(arrayIn(acroForm, 'Fields'), (field) => arrayIn(field, 'Kids'));
  } catch (error) {
    if (error instanceof XrefUnusableError) return KEPT;
    throw error;
  }

  const replaced: number[] = [];
  for (const { ref, object } of pending.values()) {
    context.assign(ref, object);
    replaced.push(ref.objectNumber);
  }
  // pdf-lib keeps the trailer it parsed last, which need not be the newest section's.
  if (context.trailerInfo.Root?.toString() !== root.toString()) replaced.push(root.objectNumber);
  context.trailerInfo.Root = root;
  for (const key of ['Info', 'ID', 'Encrypt'] as const) {
    const value = reader.chain.trailer.get(name(key));
    if (value !== undefined) context.trailerInfo[key] = value;
  }
  return { usable: true, replaced };
}
