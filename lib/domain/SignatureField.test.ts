import { describe, expect, it } from 'vitest';
import { SignatureField, SignatureFieldValidationError } from './SignatureField';

const valid = { page: 1, xRatio: 0.5, yRatio: 0.7, widthRatio: 0.3, heightRatio: 0.1 };

describe('SignatureField.createMany', () => {
  it('accepts a valid field', () => {
    const [field] = SignatureField.createMany([valid]);
    expect(field!.page).toBe(1);
  });

  it('rejects an empty list', () => {
    expect(() => SignatureField.createMany([])).toThrow(/at least 1 signatureField/);
  });

  it.each([
    ['null item', null, /must be an object/],
    ['string item', 'abc', /must be an object/],
    ['non-integer page', { ...valid, page: 1.5 }, /page must be a 1-based integer/],
    ['missing xRatio', { ...valid, xRatio: undefined }, /xRatio must be a finite number, got undefined/],
    ['NaN widthRatio', { ...valid, widthRatio: NaN }, /widthRatio must be a finite number/],
    ['string yRatio', { ...valid, yRatio: '0.5' }, /yRatio must be a finite number, got "0.5"/],
    ['widthRatio out of range', { ...valid, widthRatio: 0.9 }, /widthRatio must be between/],
    ['heightRatio out of range', { ...valid, heightRatio: 0.01 }, /heightRatio must be between/],
  ])('rejects %s with a SignatureFieldValidationError', (_label, item, message) => {
    expect(() => SignatureField.createMany([item])).toThrow(SignatureFieldValidationError);
    expect(() => SignatureField.createMany([item])).toThrow(message);
  });

  it('accepts any number of fields on one page (no per-page cap)', () => {
    expect(SignatureField.createMany(Array.from({ length: 8 }, () => valid))).toHaveLength(8);
  });
});

describe('SignatureField.toCasConvention', () => {
  it('flips the Y axis to bottom-edge-from-page-bottom', () => {
    const [field] = SignatureField.createMany([valid]);
    const cas = field!.toCasConvention();
    expect(cas.yRatio).toBeCloseTo(1 - 0.7 - 0.1);
    expect(cas).toMatchObject({ page: 1, xRatio: 0.5, widthRatio: 0.3, heightRatio: 0.1, fieldType: 'SIGNATURE' });
  });
});
