import { describe, expect, it } from 'vitest';
import {
  assertAppendedUpdateIsExact,
  buildIncrementalUpdate,
  type BuildUpdateInput,
} from './incremental.ts';
import type { XrefKind } from './rawPdf.ts';

const body = (text: string) => Buffer.from(text, 'latin1');
const ORIGINAL_LENGTH = 5000;
const PREV = 4321;

function build(kind: XrefKind, over: Partial<BuildUpdateInput> = {}) {
  return buildIncrementalUpdate({
    originalLength: ORIGINAL_LENGTH,
    needsSeparator: false,
    kind,
    prevStartXref: PREV,
    nextObjectNumber: 40,
    trailer: { root: '1 0 R', info: '2 0 R', id: '[<AA> <BB>]' },
    objects: [
      { number: 7, generation: 3, body: body('<< /Annots [ 38 0 R ] >>') },
      { number: 38, generation: 0, body: body('<< /Subtype /Widget >>') },
      { number: 39, generation: 0, body: body('<< /Type /Sig >>') },
    ],
    ...over,
  });
}

/** assertAppendedUpdateIsExact only looks at the tail, but offsets are absolute. */
const check = (tail: Buffer, kind: XrefKind, prev = PREV) =>
  assertAppendedUpdateIsExact(tail, ORIGINAL_LENGTH, kind, prev);

describe('buildIncrementalUpdate', () => {
  it('writes a classic table with the objects generations, runs of numbers and /Prev', () => {
    const { tail, objectOffsets } = build('table');
    const text = tail.toString('latin1');
    expect(text).toContain('7 3 obj\n<< /Annots [ 38 0 R ] >>\nendobj\n');
    // 7 stands alone; 38-39 are one run.
    expect(text).toMatch(/xref\n7 1\n\d{10} 00003 n\r\n38 2\n\d{10} 00000 n\r\n\d{10} 00000 n\r\n/);
    expect(text).toContain(
      'trailer\n<< /Size 40 /Root 1 0 R /Prev 4321 /Info 2 0 R /ID [<AA> <BB>] >>'
    );
    expect(text).toMatch(/startxref\n\d+\n%%EOF\n$/);
    expect([...objectOffsets.keys()]).toEqual([7, 38, 39]);
    check(tail, 'table');
  });

  it('writes an xref stream that lists its own object and every written one', () => {
    const { tail } = build('stream');
    const text = tail.toString('latin1');
    expect(text).toContain(
      '40 0 obj\n<< /Type /XRef /Size 41 /W [1 4 2] /Index [7 1 38 3] /Root 1 0 R /Prev 4321'
    );
    expect(text).toContain('/Length 28 >>\nstream\n');
    check(tail, 'stream');
  });

  it('adds a separator only when asked, and offsets stay exact either way', () => {
    for (const kind of ['table', 'stream'] as const) {
      const plain = build(kind);
      const separated = build(kind, { needsSeparator: true });
      expect(separated.tail.length).toBe(plain.tail.length + 1);
      expect(separated.tail[0]).toBe(0x0a);
      check(separated.tail, kind);
    }
  });

  it('works without /Info and /ID', () => {
    for (const kind of ['table', 'stream'] as const) {
      const { tail } = build(kind, { trailer: { root: '1 0 R' } });
      expect(tail.toString('latin1')).not.toContain('/Info');
      expect(tail.toString('latin1')).not.toContain('/ID');
      check(tail, kind);
    }
  });

  it('refuses an object number written twice', () => {
    expect(() =>
      build('table', {
        objects: [
          { number: 7, generation: 0, body: body('<<>>') },
          { number: 7, generation: 0, body: body('<<>>') },
        ],
      })
    ).toThrowError(/written twice/);
  });
});

describe('assertAppendedUpdateIsExact', () => {
  const fails = (tail: Buffer, kind: XrefKind, prev = PREV) =>
    expect(() => check(tail, kind, prev)).toThrowError(/not exact/);

  for (const kind of ['table', 'stream'] as const) {
    describe(kind, () => {
      it('refuses a /Prev that is not the previous section', () => {
        fails(build(kind).tail, kind, PREV + 1);
      });

      it('refuses an object that is not where the section says', () => {
        const { tail } = build(kind);
        // Insert a byte before the objects' offsets are recorded: every offset after it is now wrong.
        const shifted = Buffer.concat([Buffer.from(' '), tail]);
        fails(shifted, kind);
      });

      it('refuses a generation that does not match the object header', () => {
        const text = build(kind).tail.toString('latin1').replace('7 3 obj', '7 4 obj');
        fails(Buffer.from(text, 'latin1'), kind);
      });

      it('refuses a missing %%EOF or startxref', () => {
        const { tail } = build(kind);
        fails(tail.subarray(0, tail.length - 6), kind);
        fails(
          Buffer.from(tail.toString('latin1').replace('startxref', 'startxrfe'), 'latin1'),
          kind
        );
      });
    });
  }

  it('refuses a startxref that points outside the update', () => {
    const { tail } = build('table');
    const text = tail.toString('latin1').replace(/startxref\n\d+/, 'startxref\n12');
    fails(Buffer.from(text, 'latin1'), 'table');
  });
});
