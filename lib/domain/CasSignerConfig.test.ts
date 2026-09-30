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
});
