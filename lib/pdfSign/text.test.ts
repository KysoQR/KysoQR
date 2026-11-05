import { describe, expect, it } from 'vitest';
import { sanitizeDisplayText } from './text.ts';

// Built from code points: invisible characters do not belong in a source file.
const char = (codePoint: number) => String.fromCodePoint(codePoint);

describe('sanitizeDisplayText', () => {
  it('collapses whitespace and trims', () => {
    expect(sanitizeDisplayText('  Nguyen \t Van\n\r A  ', 100)).toBe('Nguyen Van A');
    expect(sanitizeDisplayText('', 100)).toBe('');
    expect(sanitizeDisplayText('  \n\t ', 100)).toBe('');
  });

  it('drops bidi overrides and isolates, which could reorder a name on screen', () => {
    const rlo = char(0x202e);
    const lri = char(0x2066);
    const pdi = char(0x2069);
    expect(sanitizeDisplayText(`A${rlo}BC${lri}D${pdi}E`, 100)).toBe('A BC D E');
  });

  it('drops zero-width and other invisible characters, controls and separators', () => {
    const invisibles = [
      0x00ad, 0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x2060, 0xfeff,
      0x0000, 0x0007, 0x007f, 0x0085, 0x009f,
    ];
    for (const codePoint of invisibles) {
      expect(sanitizeDisplayText(`ab${char(codePoint)}cd`, 100)).toBe('ab cd');
    }
  });

  it('keeps a no-break space (the signing time relies on it) and normalizes accents to NFC', () => {
    expect(sanitizeDisplayText(`10:15:21${char(0xa0)}+07:00`, 100)).toBe(
      `10:15:21${char(0xa0)}+07:00`
    );
    const decomposed = `Nguye${char(0x0302)}${char(0x0303)}n`; // e + circumflex + tilde
    expect(sanitizeDisplayText(decomposed, 100)).toBe(decomposed.normalize('NFC'));
    expect(sanitizeDisplayText('Nguyễn Đức Thịnh', 100)).toBe('Nguyễn Đức Thịnh');
  });

  it('removes lone surrogates but keeps valid pairs', () => {
    const lone = String.fromCharCode(0xd800);
    expect(sanitizeDisplayText(`a${lone}b`, 100)).toBe('ab');
    expect(sanitizeDisplayText(`a${String.fromCharCode(0xdc00)}b`, 100)).toBe('ab');
    const pair = char(0x1f600);
    expect(sanitizeDisplayText(`a${pair}b`, 100)).toBe(`a${pair}b`);
  });

  it('caps the length in characters, not UTF-16 units, and never ends on a space', () => {
    const pair = char(0x1f600);
    expect([...sanitizeDisplayText(pair.repeat(10), 4)]).toHaveLength(4);
    expect(sanitizeDisplayText('aaaa bbbb', 5)).toBe('aaaa');
    expect(sanitizeDisplayText('abcdef', 3)).toBe('abc');
    expect(sanitizeDisplayText('x'.repeat(10_000), 100)).toHaveLength(100);
  });
});
