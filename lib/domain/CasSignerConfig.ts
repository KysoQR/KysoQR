/** Ported from x-sign-api/src/domain/intent/CasSignerConfig.ts.
 *
 * An individual with no `identificationNumber` is legitimate: CAS's own API
 * treats identity as something the signer confirms afterwards, in the Cas ID
 * app during the QR step (QR-only signing is a deliberate, supported path).
 * An enterprise signer, however, MUST provide a `taxCode` -- that's what
 * makes it an enterprise signature (same rule as the signing form's
 * `isCasSignerConfigValid`). FORMAT is checked whenever a value is present --
 * typing a malformed CCCD/tax code shouldn't silently reach CAS as garbage.
 * `organizationName`/`representativeName` stay optional too, matching
 * x-sign-web's original `casSignerForm.ts`: CAS's own submit call only ever
 * receives `organizationName` when non-empty (never `representativeName` at
 * all, see `CasProvider`'s submit input type) — they're locally-typed
 * display metadata, not something CAS requires to accept the request. */

export type SignerType = 'individual' | 'enterprise';

const CCCD_OR_CMND = /^\d{9}$|^\d{12}$/;
const TAX_CODE = /^\d{10}$|^\d{10}-\d{3}$/;

export interface CasSignerConfigInput {
  signerType: SignerType;
  identificationNumber?: string | null;
  taxCode?: string | null;
  organizationName?: string | null;
  representativeName?: string | null;
}

export class CasSignerConfigValidationError extends Error {}

export class CasSignerConfig {
  private constructor(
    private readonly props: {
      signerType: SignerType;
      identificationNumber: string | null;
      taxCode: string | null;
      organizationName: string | null;
      representativeName: string | null;
    }
  ) {}

  static create(input: CasSignerConfigInput): CasSignerConfig {
    const identificationNumber = input.identificationNumber?.trim() || null;
    if (identificationNumber && !CCCD_OR_CMND.test(identificationNumber)) {
      throw new CasSignerConfigValidationError('identificationNumber must be 9 or 12 digits');
    }

    if (input.signerType === 'enterprise') {
      const taxCode = input.taxCode?.trim() || null;
      const organizationName = input.organizationName?.trim() || null;
      const representativeName = input.representativeName?.trim() || null;
      if (!taxCode) {
        throw new CasSignerConfigValidationError('taxCode is required for enterprise signers');
      }
      if (!TAX_CODE.test(taxCode)) {
        throw new CasSignerConfigValidationError(
          'taxCode must be 10 digits, optionally followed by -NNN'
        );
      }
      return new CasSignerConfig({
        signerType: 'enterprise',
        identificationNumber,
        taxCode,
        organizationName,
        representativeName,
      });
    }

    return new CasSignerConfig({
      signerType: 'individual',
      identificationNumber,
      taxCode: null,
      organizationName: null,
      representativeName: null,
    });
  }

  get identificationNumber(): string | null {
    return this.props.identificationNumber;
  }

  get organizationName(): string | null {
    return this.props.organizationName;
  }

  /** Only enterprise signers submit a taxCode to CAS. */
  taxCodeForSubmission(): string | null {
    return this.props.signerType === 'enterprise' ? this.props.taxCode : null;
  }
}
