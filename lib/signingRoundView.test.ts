import { describe, expect, it } from 'vitest';
import { isLookupCode, maskCitizenId } from './signingRoundView';

describe('maskCitizenId', () => {
  it('keeps the prefix and the last 4 digits of a citizen ID', () => {
    expect(maskCitizenId('CCCD:123456789101')).toBe('CCCD:********9101');
    expect(maskCitizenId(' cccd : 123456789101 ')).toBe('CCCD:********9101');
    expect(maskCitizenId('123456789101')).toBe('********9101');
    expect(maskCitizenId('CMND:123456789')).toBe('CMND:*****6789');
  });

  it('never shows a short ID in full', () => {
    expect(maskCitizenId('CCCD:1234')).toBe('CCCD:****');
    expect(maskCitizenId('12')).toBe('****');
  });

  it('keeps a company tax code, which is public', () => {
    expect(maskCitizenId('MST:0312345678')).toBe('MST:0312345678');
  });

  it('returns null for nothing', () => {
    expect(maskCitizenId(null)).toBeNull();
    expect(maskCitizenId(undefined)).toBeNull();
    expect(maskCitizenId('  ')).toBeNull();
  });
});

describe('isLookupCode', () => {
  it('accepts <origin>#<code> only', () => {
    expect(isLookupCode('kysoqr.com#3bLzsA')).toBe(true);
    expect(isLookupCode('3bLzsA')).toBe(false);
    expect(isLookupCode('kysoqr.com#3bL')).toBe(false);
    expect(isLookupCode('kysoqr.com#3bLzsA/../x')).toBe(false);
  });
});
