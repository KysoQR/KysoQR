import { PdfSignError } from './errors.ts';
import type { XrefKind } from './rawPdf.ts';

/**
 * Writes the part of an incremental update that follows the changed objects:
 * the objects themselves, a cross-reference section and the trailer.
 *
 * The section is written in the SAME form as the file's previous one -- a
 * classic table after a table, an xref stream after an xref stream -- because
 * mixing the two across revisions is something strict readers reject, and the
 * agent's old code always wrote a table. Object generations are kept as they
 * were (the old code wrote 0 for everything) and /Size never drops below what
 * the previous trailer declared.
 */

export interface UpdateObject {
  number: number;
  generation: number;
  /** The object's content: everything between `N G obj` and `endobj`. */
  body: Buffer;
}

export interface UpdateTrailer {
  /** "12 0 R" */
  root: string;
  info?: string | undefined;
  /** "[<..> <..>]" */
  id?: string | undefined;
}

export interface BuildUpdateInput {
  /** Length of the file being updated; the first appended byte is at this offset. */
  originalLength: number;
  /** True when the original does not end with an end-of-line. */
  needsSeparator: boolean;
  objects: UpdateObject[];
  kind: XrefKind;
  /** Offset of the previous xref section (its `startxref` value). */
  prevStartXref: number;
  /** First unused object number: above the old /Size and every object number in use. */
  nextObjectNumber: number;
  trailer: UpdateTrailer;
}

export interface BuiltUpdate {
  /** Everything appended after the original. */
  tail: Buffer;
  /** Offset inside `tail` of each object's `N G obj` line. */
  objectOffsets: Map<number, number>;
  /** Offset inside `tail` where the new xref section starts (= the new startxref). */
  xrefOffset: number;
}

/** Field widths of the xref stream we write: type (1), offset (4), generation (2). */
const XREF_WIDTHS = [1, 4, 2] as const;
const ENTRY_BYTES = XREF_WIDTHS[0] + XREF_WIDTHS[1] + XREF_WIDTHS[2];

const ascii = (text: string) => Buffer.from(text, 'latin1');

/** Groups sorted numbers into [first, count] runs of consecutive values. */
function runs(numbers: number[]): Array<[start: number, count: number]> {
  const result: Array<[number, number]> = [];
  for (let i = 0; i < numbers.length;) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j += 1;
    result.push([numbers[i]!, j - i + 1]);
    i = j + 1;
  }
  return result;
}

export function buildIncrementalUpdate(input: BuildUpdateInput): BuiltUpdate {
  const objects = [...input.objects].sort((a, b) => a.number - b.number);
  for (let i = 1; i < objects.length; i += 1) {
    if (objects[i]!.number === objects[i - 1]!.number) {
      throw new PdfSignError('JOB_FAILED', `object ${objects[i]!.number} written twice`);
    }
  }
  const byNumber = new Map(objects.map((object) => [object.number, object]));

  const parts: Buffer[] = [];
  let length = 0;
  const push = (chunk: Buffer) => {
    parts.push(chunk);
    length += chunk.length;
  };
  if (input.needsSeparator) push(ascii('\n'));

  const objectOffsets = new Map<number, number>();
  for (const object of objects) {
    objectOffsets.set(object.number, length);
    push(ascii(`${object.number} ${object.generation} obj\n`));
    push(object.body);
    push(ascii('\nendobj\n'));
  }

  const trailerEntries = [`/Root ${input.trailer.root}`, `/Prev ${input.prevStartXref}`];
  if (input.trailer.info) trailerEntries.push(`/Info ${input.trailer.info}`);
  if (input.trailer.id) trailerEntries.push(`/ID ${input.trailer.id}`);

  const xrefOffset = length;
  if (input.kind === 'table') {
    let xref = 'xref\n';
    for (const [start, count] of runs(objects.map((o) => o.number))) {
      xref += `${start} ${count}\n`;
      for (let n = start; n < start + count; n += 1) {
        const offset = input.originalLength + objectOffsets.get(n)!;
        // Exactly 20 bytes per entry: 10 + 1 + 5 + 1 + 1 + CRLF.
        xref += `${String(offset).padStart(10, '0')} ${String(byNumber.get(n)!.generation).padStart(5, '0')} n\r\n`;
      }
    }
    push(
      ascii(
        `${xref}trailer\n<< /Size ${input.nextObjectNumber} ${trailerEntries.join(' ')} >>\n` +
          `startxref\n${input.originalLength + xrefOffset}\n%%EOF\n`
      )
    );
  } else {
    // The xref stream is an object too, numbered right after the last one.
    const streamNumber = input.nextObjectNumber;
    const entries = [...objects.map((o) => o.number), streamNumber];
    const data = Buffer.alloc(entries.length * ENTRY_BYTES);
    entries.forEach((number, index) => {
      const own = number === streamNumber;
      const offset = input.originalLength + (own ? xrefOffset : objectOffsets.get(number)!);
      const at = index * ENTRY_BYTES;
      data.writeUInt8(1, at);
      data.writeUInt32BE(offset, at + 1);
      data.writeUInt16BE(own ? 0 : byNumber.get(number)!.generation, at + 5);
    });
    const index = runs(entries).flat().join(' ');
    const dict =
      `<< /Type /XRef /Size ${streamNumber + 1} /W [${XREF_WIDTHS.join(' ')}] /Index [${index}] ` +
      `${trailerEntries.join(' ')} /Length ${data.length} >>`;
    push(ascii(`${streamNumber} 0 obj\n${dict}\nstream\n`));
    push(data);
    push(ascii(`\nendstream\nendobj\nstartxref\n${input.originalLength + xrefOffset}\n%%EOF\n`));
  }

  return { tail: Buffer.concat(parts, length), objectOffsets, xrefOffset };
}

/**
 * Re-reads the update that was appended (`tail`, which starts at absolute
 * offset `originalLength`) and checks it against its own bytes: `startxref`
 * points at the xref section, every entry points at the right `N G obj`, /Prev
 * points at the previous section. A bug in the writer then stops the job
 * instead of producing a file some viewer silently repairs.
 */
export function assertAppendedUpdateIsExact(
  tail: Buffer,
  originalLength: number,
  kind: XrefKind,
  prevStartXref: number
): void {
  const fail = (what: string): never => {
    throw new PdfSignError('SELF_CHECK_FAILED', `appended xref section is not exact: ${what}`);
  };
  const text = tail.toString('latin1');
  const end = /startxref\n(\d+)\n%%EOF\n$/.exec(text.slice(-64));
  if (!end) return fail('missing startxref / %%EOF at the end');
  const startxref = Number(end[1]);
  // Absolute file offset -> offset inside `tail`.
  const rel = (offset: number) => offset - originalLength;
  if (!(startxref >= originalLength && startxref < originalLength + tail.length)) {
    return fail('startxref does not point into the update');
  }

  const entries = new Map<number, { offset: number; generation: number }>();
  let prev: number | undefined;

  if (kind === 'table') {
    if (tail.toString('latin1', rel(startxref), rel(startxref) + 5) !== 'xref\n') {
      return fail('startxref is not at the xref keyword');
    }
    const trailerAt = tail.indexOf('trailer', rel(startxref), 'latin1');
    if (trailerAt < 0) return fail('no trailer');
    let objectNumber = 0;
    for (const line of tail.toString('latin1', rel(startxref) + 5, trailerAt).split('\n')) {
      if (line === '') continue;
      const subsection = /^(\d+) (\d+)$/.exec(line);
      if (subsection) {
        objectNumber = Number(subsection[1]);
        continue;
      }
      const entry = /^(\d{10}) (\d{5}) n\r$/.exec(line);
      if (!entry) return fail(`unexpected xref line "${line.slice(0, 24)}"`);
      entries.set(objectNumber, { offset: Number(entry[1]), generation: Number(entry[2]) });
      objectNumber += 1;
    }
    prev = Number(/\/Prev (\d+)/.exec(tail.toString('latin1', trailerAt, trailerAt + 4096))?.[1]);
  } else {
    const head = tail.toString('latin1', rel(startxref), rel(startxref) + 1024);
    const dict =
      /^(\d+) 0 obj\n<< \/Type \/XRef \/Size (\d+) \/W \[1 4 2\] \/Index \[([\d ]+)\] (.*?) \/Length (\d+) >>\nstream\n/.exec(
        head
      );
    if (!dict) return fail('startxref is not at our xref stream');
    const streamNumber = Number(dict[1]);
    const length = Number(dict[5]);
    const dataAt = rel(startxref) + dict[0].length;
    const data = tail.subarray(dataAt, dataAt + length);
    const numbers: number[] = [];
    const index = dict[3]!.trim().split(' ').map(Number);
    for (let i = 0; i + 1 < index.length; i += 2) {
      for (let n = 0; n < index[i + 1]!; n += 1) numbers.push(index[i]! + n);
    }
    if (numbers.length * ENTRY_BYTES !== length || data.length !== length) {
      return fail('xref stream length does not match /Index');
    }
    numbers.forEach((number, i) => {
      const at = i * ENTRY_BYTES;
      if (data.readUInt8(at) !== 1) fail('xref stream entry is not type 1');
      entries.set(number, {
        offset: data.readUInt32BE(at + 1),
        generation: data.readUInt16BE(at + 5),
      });
    });
    if (entries.get(streamNumber)?.offset !== startxref)
      return fail('xref stream does not list itself at startxref');
    const closing = '\nendstream\nendobj\n';
    if (tail.toString('latin1', dataAt + length, dataAt + length + closing.length) !== closing) {
      return fail('xref stream is not terminated');
    }
    prev = Number(/\/Prev (\d+)/.exec(dict[4]!)?.[1]);
  }

  if (prev !== prevStartXref) return fail('/Prev does not point at the previous xref section');
  if (entries.size === 0) return fail('no entries');
  for (const [number, { offset, generation }] of entries) {
    // Every object sits between the original and the xref section; only an
    // xref stream also lists itself, at `startxref`.
    const inRange =
      offset >= originalLength &&
      (offset < startxref || (kind === 'stream' && offset === startxref));
    if (!inRange) return fail(`object ${number} offset outside the update`);
    const expected = `${number} ${generation} obj`;
    if (tail.toString('latin1', rel(offset), rel(offset) + expected.length) !== expected) {
      return fail(`object ${number} is not at offset ${offset}`);
    }
  }
}
