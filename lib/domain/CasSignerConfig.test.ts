import { describe, expect, it } from 'vitest';
import { CasSignerConfig, CasSignerConfigValidationError, isSignType } from './CasSignerConfig';

describe('CasSignerConfig.create', () => {
  it('accepts no signType and no details at all (the signer chooses, QR-only)', () => {
    const config = CasSignerConfig.create({});
    expect(config.signTypeForSubmission()).toBeNull();
    expect(config.identificationNumber).toBeNull();
    expect(config.taxCodeForSubmission()).toBeNull();
  });

  it('rejects a malformed CCCD, whatever the signType', () => {
    for (const signType of [null, 'PERSONAL', 'BUSINESS'] as const) {
      expect(() => CasSignerConfig.create({ signType, identificationNumber: '12345' })).toThrow(
        CasSignerConfigValidationError
      );
    }
  });

  it('PERSONAL: keeps the CCCD, never submits a tax code or organization', () => {
    const config = CasSignerConfig.create({
      signType: 'PERSONAL',
      identificationNumber: ' 010101010101 ',
      taxCode: '0101010101',
      organizationName: 'ACME',
    });
    expect(config.signTypeForSubmission()).toBe('PERSONAL');
    expect(config.identificationNumber).toBe('010101010101');
    expect(config.taxCodeForSubmission()).toBeNull();
    expect(config.organizationName).toBeNull();
  });

  it('no signType: a tax code is ignored, not validated', () => {
    const config = CasSignerConfig.create({ taxCode: 'not-a-tax-code' });
    expect(config.signTypeForSubmission()).toBeNull();
    expect(config.taxCodeForSubmission()).toBeNull();
  });

  describe('BUSINESS', () => {
    it.each([undefined, null, '', '   '])(
      'does not require a tax code (taxCode = %j): any enterprise certificate',
      (taxCode) => {
        const config = CasSignerConfig.create({ signType: 'BUSINESS', taxCode });
        expect(config.signTypeForSubmission()).toBe('BUSINESS');
        expect(config.taxCodeForSubmission()).toBeNull();
      }
    );

    it.each(['0101010101', '0101010101-001', ' 0101010101 '])('accepts tax code %j', (taxCode) => {
      expect(
        CasSignerConfig.create({ signType: 'BUSINESS', taxCode }).taxCodeForSubmission()
      ).toBe(taxCode.trim());
    });

    it.each(['123', '01234567890', '0123456789-01', '01234567AB'])(
      'rejects a malformed tax code %j',
      (taxCode) => {
        expect(() => CasSignerConfig.create({ signType: 'BUSINESS', taxCode })).toThrow(
          /taxCode must be 10 digits/
        );
      }
    );

    it('keeps the signing person\'s CCCD and the organization name', () => {
      const config = CasSignerConfig.create({
        signType: 'BUSINESS',
        taxCode: '0101010101',
        identificationNumber: '079123456',
        organizationName: ' ACME ',
      });
      expect(config.identificationNumber).toBe('079123456');
      expect(config.organizationName).toBe('ACME');
    });
  });
});

describe('isSignType', () => {
  it('accepts only PERSONAL / BUSINESS', () => {
    expect(isSignType('PERSONAL')).toBe(true);
    expect(isSignType('BUSINESS')).toBe(true);
    for (const value of ['personal', 'individual', 'enterprise', '', null, undefined, 1]) {
      expect(isSignType(value)).toBe(false);
    }
  });
});
