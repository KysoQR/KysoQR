import { describe, expect, it } from 'vitest';
import { CasSignerConfig, CasSignerConfigValidationError } from './CasSignerConfig';

describe('CasSignerConfig.create', () => {
  it('accepts an individual with no details at all (QR-only signing)', () => {
    const config = CasSignerConfig.create({ signerType: 'individual' });
    expect(config.identificationNumber).toBeNull();
    expect(config.taxCodeForSubmission()).toBeNull();
  });

  it('rejects a malformed CCCD', () => {
    expect(() =>
      CasSignerConfig.create({ signerType: 'individual', identificationNumber: '12345' })
    ).toThrow(CasSignerConfigValidationError);
  });

  it.each([undefined, null, '', '   '])(
    'requires a tax code for an enterprise signer (taxCode = %j)',
    (taxCode) => {
      expect(() => CasSignerConfig.create({ signerType: 'enterprise', taxCode })).toThrow(
        'taxCode is required for enterprise signers'
      );
    }
  );

  it('rejects a malformed enterprise tax code', () => {
    expect(() => CasSignerConfig.create({ signerType: 'enterprise', taxCode: '123' })).toThrow(
      /taxCode must be 10 digits/
    );
  });

  it.each(['0316794479', '0316794479-001'])('accepts enterprise tax code %s', (taxCode) => {
    expect(CasSignerConfig.create({ signerType: 'enterprise', taxCode }).taxCodeForSubmission()).toBe(
      taxCode
    );
  });

  describe('enterprise signer with the signing person\'s CCCD (so Cas ID sends a notification)', () => {
    it.each(['077088002778', '079123456'])('keeps CCCD %s next to the tax code', (identificationNumber) => {
      const config = CasSignerConfig.create({
        signerType: 'enterprise',
        taxCode: '0316794479',
        identificationNumber,
      });
      expect(config.taxCodeForSubmission()).toBe('0316794479');
      expect(config.identificationNumber).toBe(identificationNumber);
    });

    it('trims the CCCD, and a blank one means QR-only signing', () => {
      expect(
        CasSignerConfig.create({
          signerType: 'enterprise',
          taxCode: '0316794479',
          identificationNumber: ' 077088002778 ',
        }).identificationNumber
      ).toBe('077088002778');
      expect(
        CasSignerConfig.create({ signerType: 'enterprise', taxCode: '0316794479', identificationNumber: '  ' })
          .identificationNumber
      ).toBeNull();
    });

    it('rejects a malformed CCCD even though the tax code is fine', () => {
      expect(() =>
        CasSignerConfig.create({
          signerType: 'enterprise',
          taxCode: '0316794479',
          identificationNumber: '12345',
        })
      ).toThrow(/identificationNumber must be 9 or 12 digits/);
    });
  });
});
