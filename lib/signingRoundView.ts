import type { SigningRoundCertParty, SigningRoundDetail } from './cas/CasProvider';

/**
 * What GET /api/verify/signing-round may show about a signing round. Anyone
 * holding a signed PDF has its lookup code, so this is effectively public data:
 * it is rebuilt field by field from CAS's record (an allow-list, so a field CAS
 * adds later never leaks by default), the signer's citizen ID is masked to its
 * last 4 digits, and of the device only the model is kept.
 */

/** Lookup code shape: `<origin>#<code>`, e.g. `kysoqr.com#3bLzsA`. */
const LOOKUP_CODE = /^[A-Za-z0-9.-]{1,64}#[A-Za-z0-9]{6,32}$/;

export function isLookupCode(value: string): boolean {
  return LOOKUP_CODE.test(value);
}

const VISIBLE_DIGITS = 4;
const MAX_MODEL_LENGTH = 64;

/**
 * `CCCD:123456789101` -> `CCCD:********9101`. A company tax code (`MST:...`) is
 * public and kept as is; any other value (CCCD, CMND, no prefix) is masked.
 */
export function maskCitizenId(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = /^\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(value);
  const prefix = match ? match[1]!.toUpperCase() : '';
  const id = (match ? match[2]! : value).trim();
  if (prefix === 'MST') return `MST:${id}`;
  const shown = id.length > VISIBLE_DIGITS ? id.slice(-VISIBLE_DIGITS) : '';
  const masked = '*'.repeat(Math.max(id.length - shown.length, VISIBLE_DIGITS)) + shown;
  return prefix ? `${prefix}:${masked}` : masked;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function party(source: Partial<SigningRoundCertParty> | undefined, withId: boolean) {
  const view: SigningRoundCertParty = {
    commonName: text(source?.commonName),
    country: text(source?.country),
  };
  if (source && 'organization' in source) view.organization = text(source.organization);
  if (withId) {
    const id = maskCitizenId(source?.taxOrCitizenId);
    if (id) view.taxOrCitizenId = id;
  }
  return view;
}

export function signingRoundView(round: SigningRoundDetail): SigningRoundDetail {
  const certificate = round.certificate ?? ({} as Partial<SigningRoundDetail['certificate']>);
  const model = text(round.device?.model);
  return {
    device: model && model.length <= MAX_MODEL_LENGTH ? { model } : {},
    signer: { displayName: text(round.signer?.displayName) ?? '' },
    authMethod: text(round.authMethod) ?? '',
    signedAt: text(round.signedAt),
    certificate: {
      issuer: party(certificate.issuer, false),
      signer: party(certificate.signer, true),
      documentIntegrity: text(certificate.documentIntegrity) ?? '',
      validFrom: text(certificate.validFrom),
      validTo: text(certificate.validTo),
      signatureValidity: text(certificate.signatureValidity) ?? '',
      hasTimestamp: text(certificate.hasTimestamp) ?? '',
      signedAtLong: text(certificate.signedAtLong),
    },
  };
}
