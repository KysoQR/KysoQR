import { describe, expect, it } from 'vitest';
import {
  SignatureField,
  SignatureFieldValidationError,
  makeAvailableField,
  type SignatureFieldProps,
} from './SignatureField';

const overlaps = (a: SignatureFieldProps, b: SignatureFieldProps) =>
  a.xRatio < b.xRatio + b.widthRatio &&
  a.xRatio + a.widthRatio > b.xRatio &&
  a.yRatio < b.yRatio + b.heightRatio &&
  a.yRatio + a.heightRatio > b.yRatio;

describe('makeAvailableField', () => {
  it('without a visible band keeps the old default slot near the page bottom', () => {
    expect(makeAvailableField(2, [])).toEqual({
      page: 2,
      xRatio: 0.52,
      yRatio: 0.78,
      widthRatio: 0.34,
      heightRatio: 0.1,
    });
  });

  it('centres the box in the part of the page on screen', () => {
    const field = makeAvailableField(1, [], { top: 0, bottom: 0.5 });
    expect(field.page).toBe(1);
    expect(field.yRatio + field.heightRatio / 2).toBeCloseTo(0.25);
    expect(field.yRatio).toBeGreaterThanOrEqual(0);
    expect(field.yRatio + field.heightRatio).toBeLessThanOrEqual(0.5);
  });

  it('avoids an existing box while staying inside the visible band', () => {
    const band = { top: 0.2, bottom: 0.6 };
    const first = makeAvailableField(1, [], band);
    const second = makeAvailableField(1, [first], band);
    expect(overlaps(first, second)).toBe(false);
    expect(second.yRatio).toBeGreaterThanOrEqual(band.top);
    expect(second.yRatio + second.heightRatio).toBeLessThanOrEqual(band.bottom);
  });

  it('keeps the box on the page when the band is at the very bottom', () => {
    const field = makeAvailableField(1, [], { top: 0.95, bottom: 1 });
    expect(field.yRatio).toBeLessThanOrEqual(1 - field.heightRatio + 1e-9);
    expect(field.yRatio).toBeGreaterThanOrEqual(0);
  });

  it('still lands in view (overlapping) when every slot in view is taken', () => {
    const band = { top: 0.4, bottom: 0.5 };
    const first = makeAvailableField(1, [], band);
    const second = makeAvailableField(1, [first], band);
    const third = makeAvailableField(1, [first, second], band);
    expect(third.yRatio + third.heightRatio / 2).toBeCloseTo(0.45);
  });
});

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
