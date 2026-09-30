import { describe, expect, it } from 'vitest';
import { signedFileName } from './downloadSignedPdf';

describe('signedFileName', () => {
  it.each([
    ['QC1840926_HD_casso_1609_(1).pdf', 'QC1840926_HD_casso_1609_(1)_signed.pdf'],
    ['Hop dong.PDF', 'Hop dong_signed.pdf'],
    ['contract_signed.pdf', 'contract_signed.pdf'],
    ['signed.pdf', 'signed.pdf'],
    ['', 'signed.pdf'],
    [null, 'signed.pdf'],
  ])('%s -> %s', (input, expected) => {
    expect(signedFileName(input)).toBe(expected);
  });
});
