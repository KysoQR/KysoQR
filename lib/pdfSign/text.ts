/**
 * Cleans text that ends up somewhere a human reads it: inside the visible
 * signature box, or in the document name VNeID shows on the signer's phone.
 *
 * What goes: control characters (C0/C1), the soft hyphen, bidi marks,
 * overrides and isolates (a name that visually reverses part of the line),
 * zero-width and other invisible formatting characters, line/paragraph
 * separators, lone surrogates. ASCII whitespace collapses to single spaces; a
 * no-break space (U+00A0) is kept on purpose -- the signing time uses it to
 * stay on one line.
 *
 * Works on code points through a range table rather than a regular
 * expression, so every range is written as a plain number.
 */

/** Inclusive code point ranges that are replaced by a space. */
const FORBIDDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], // C0 controls (tab/newline included; whitespace is re-added below)
  [0x007f, 0x009f], // DEL and C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x061c, 0x061c], // Arabic letter mark
  [0x180e, 0x180e], // Mongolian vowel separator
  [0x200b, 0x200f], // zero-width space/joiners, LRM, RLM
  [0x2028, 0x202e], // line/paragraph separators, bidi embeddings and overrides
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates, deprecated formatting
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0xfff9, 0xfffb], // interlinear annotation
];

function isForbidden(codePoint: number): boolean {
  return FORBIDDEN_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

const isLoneSurrogate = (codePoint: number) => codePoint >= 0xd800 && codePoint <= 0xdfff;
const isAsciiSpace = (char: string) =>
  char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f' || char === '\v';

export function sanitizeDisplayText(value: string, maxChars: number): string {
  let result = '';
  let count = 0;
  let pendingSpace = false;
  // String iteration walks code points; a lone surrogate comes through alone.
  for (const char of value.normalize('NFC')) {
    const codePoint = char.codePointAt(0)!;
    if (isLoneSurrogate(codePoint)) continue;
    if (isAsciiSpace(char) || isForbidden(codePoint)) {
      pendingSpace = result !== '';
      continue;
    }
    if (count >= maxChars) break;
    if (pendingSpace) {
      if (count + 1 >= maxChars) break;
      result += ' ';
      count += 1;
      pendingSpace = false;
    }
    result += char;
    count += 1;
  }
  return result;
}
