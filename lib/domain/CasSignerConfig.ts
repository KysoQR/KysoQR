/** Ported from x-sign-api/src/domain/intent/CasSignerConfig.ts, updated for
 * CAS's `signType` (same contract as the Cas Sign app's
 * `lib/request-document.ts`).
 *
 * `signType` decides how the signer must sign in Cas ID:
 * - `PERSONAL`: with their personal certificate; they can't switch.
 * - `BUSINESS`: with an enterprise certificate; they can't switch. With a
 *   `taxCode`, it must be the certificate of THAT enterprise; without one,
 *   any enterprise certificate they hold.
 * - none (`null`): the signer chooses in Cas ID.
 *
 * Nothing is required: identity is confirmed in the Cas ID app during the QR
 * step (QR-only signing is a supported path), and the tax code is optional
 * even for `BUSINESS`. FORMAT is checked whenever a value is present --
 * a malformed CCCD/tax code shouldn't reach CAS as garbage. The tax code and
 * `organizationName`/`representativeName` only apply to `BUSINESS` and are
 * dropped otherwise. CAS's submit call only receives `organizationName` when
 * non-empty (never `representativeName`, see `CasProvider`'s submit input). */

export const SIGN_TYPES = ['PERSONAL', 'BUSINESS'] as const;
export type SignType = (typeof SIGN_TYPES)[number];

export const isSignType = (value: unknown): value is SignType =>
  typeof value === 'string' && (SIGN_TYPES as readonly string[]).includes(value);

const CCCD_OR_CMND = /^\d{9}$|^\d{12}$/;
const TAX_CODE = /^\d{10}$|^\d{10}-\d{3}$/;

export interface CasSignerConfigInput {
  signType?: SignType | null;
  identificationNumber?: string | null;
  taxCode?: string | null;
  organizationName?: string | null;
  representativeName?: string | null;
}

export class CasSignerConfigValidationError extends Error {}

export class CasSignerConfig {
  private constructor(
    private readonly props: {
      signType: SignType | null;
      identificationNumber: string | null;
      taxCode: string | null;
      organizationName: string | null;
      representativeName: string | null;
    }
  ) {}

  static create(input: CasSignerConfigInput): CasSignerConfig {
    const signType = input.signType ?? null;
    const identificationNumber = input.identificationNumber?.trim() || null;
    if (identificationNumber && !CCCD_OR_CMND.test(identificationNumber)) {
      throw new CasSignerConfigValidationError('identificationNumber must be 9 or 12 digits');
    }

    if (signType === 'BUSINESS') {
      const taxCode = input.taxCode?.trim() || null;
      if (taxCode && !TAX_CODE.test(taxCode)) {
        throw new CasSignerConfigValidationError(
          'taxCode must be 10 digits, optionally followed by -NNN'
        );
      }
      return new CasSignerConfig({
        signType,
        identificationNumber,
        taxCode,
        organizationName: input.organizationName?.trim() || null,
        representativeName: input.representativeName?.trim() || null,
      });
    }

    return new CasSignerConfig({
      signType,
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

  /** Sent to CAS as `signType`; `null` = not sent (the signer chooses). */
  signTypeForSubmission(): SignType | null {
    return this.props.signType;
  }

  /** Only a `BUSINESS` request submits a tax code to CAS. */
  taxCodeForSubmission(): string | null {
    return this.props.signType === 'BUSINESS' ? this.props.taxCode : null;
  }
}
