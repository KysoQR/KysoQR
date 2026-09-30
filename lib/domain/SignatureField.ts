import type { CasSignatureField } from '../cas/CasProvider';

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Ratio limits ported from x-sign-web/src/utils/signatureFields.ts ("Size
 * limits match CAS's own reference client"). MAX_WIDTH_RATIO is our own
 * addition — the old app only bounded height on both ends, not width. */
export const MIN_WIDTH_RATIO = 0.16;
export const MAX_WIDTH_RATIO = 0.6;
export const MIN_HEIGHT_RATIO = 0.055;
export const MAX_HEIGHT_RATIO = 0.22;

export interface SignatureFieldProps {
  /** 1-based page index. */
  page: number;
  xRatio: number;
  /** TOP edge, fraction of page height, measured from the page top (DOM convention). */
  yRatio: number;
  widthRatio: number;
  heightRatio: number;
}

export class SignatureFieldValidationError extends Error {}

const RATIO_KEYS = ['xRatio', 'yRatio', 'widthRatio', 'heightRatio'] as const;

/** Strings quoted, so `"abc"` and a missing value (`undefined`) read differently in the error. */
const describeValue = (value: unknown): string =>
  typeof value === 'string' ? JSON.stringify(value) : String(value);

/**
 * A signature box, expressed as a fraction (0..1) of the page box, in the
 * convention the UI displays (DOM: yRatio = top edge from the page top).
 */
export class SignatureField {
  private constructor(private readonly props: SignatureFieldProps) {}

  /** `props` comes straight from client-supplied JSON on the server, so its
   * shape is checked at runtime too, not just trusted from the type -- a
   * `null` item used to throw a plain TypeError (an unhandled 500) and a
   * non-numeric ratio went through `clamp01` as NaN. */
  static create(props: SignatureFieldProps): SignatureField {
    if (typeof props !== 'object' || props === null) {
      throw new SignatureFieldValidationError(
        `each signatureField must be an object, got ${describeValue(props)}`
      );
    }
    if (!Number.isInteger(props.page) || props.page < 1) {
      throw new SignatureFieldValidationError(
        `page must be a 1-based integer, got ${describeValue(props.page)}`
      );
    }
    for (const key of RATIO_KEYS) {
      if (!Number.isFinite(props[key])) {
        throw new SignatureFieldValidationError(
          `${key} must be a finite number, got ${describeValue(props[key])}`
        );
      }
    }
    const widthRatio = clamp01(props.widthRatio);
    const heightRatio = clamp01(props.heightRatio);
    if (widthRatio < MIN_WIDTH_RATIO || widthRatio > MAX_WIDTH_RATIO) {
      throw new SignatureFieldValidationError(
        `widthRatio must be between ${MIN_WIDTH_RATIO} and ${MAX_WIDTH_RATIO}, got ${widthRatio}`
      );
    }
    if (heightRatio < MIN_HEIGHT_RATIO || heightRatio > MAX_HEIGHT_RATIO) {
      throw new SignatureFieldValidationError(
        `heightRatio must be between ${MIN_HEIGHT_RATIO} and ${MAX_HEIGHT_RATIO}, got ${heightRatio}`
      );
    }
    return new SignatureField({
      page: props.page,
      xRatio: clamp01(props.xRatio),
      yRatio: clamp01(props.yRatio),
      widthRatio,
      heightRatio,
    });
  }

  /** Validates the whole-document rule: at least 1 field -- ALWAYS enforced
   * (fixes the old bug where this only ran when the array happened to be
   * sent). There is deliberately no per-page cap any more (the old app's
   * limit of 3 was dropped on request); each field is still validated. */
  static createMany(items: unknown[]): SignatureField[] {
    if (items.length === 0) {
      throw new SignatureFieldValidationError('at least 1 signatureField is required');
    }
    return items.map((item) => SignatureField.create(item as SignatureFieldProps));
  }

  get page(): number {
    return this.props.page;
  }

  /**
   * Convert to CAS convention (yRatio = bottom edge from the page bottom).
   * This is the ONLY place the Y axis is flipped.
   */
  toCasConvention(): CasSignatureField {
    return {
      page: this.props.page,
      xRatio: this.props.xRatio,
      yRatio: clamp01(1 - this.props.yRatio - this.props.heightRatio),
      widthRatio: this.props.widthRatio,
      heightRatio: this.props.heightRatio,
      fieldType: 'SIGNATURE',
    };
  }
}

// ---------------------------------------------------------------------------
// Client-side placement helpers — ported from x-sign-web/src/utils/signatureFields.ts
// ---------------------------------------------------------------------------

const DEFAULT_SLOTS = [
  { xRatio: 0.52, yRatio: 0.78 },
  { xRatio: 0.52, yRatio: 0.66 },
  { xRatio: 0.52, yRatio: 0.54 },
  { xRatio: 0.08, yRatio: 0.78 },
  { xRatio: 0.08, yRatio: 0.66 },
  { xRatio: 0.08, yRatio: 0.54 },
] as const;

export const makeField = (page: number, indexOnPage: number): SignatureFieldProps => {
  const slot = DEFAULT_SLOTS[indexOnPage % DEFAULT_SLOTS.length]!;
  return { page, xRatio: slot.xRatio, yRatio: slot.yRatio, widthRatio: 0.34, heightRatio: 0.1 };
};

const overlaps = (a: SignatureFieldProps, b: SignatureFieldProps): boolean =>
  a.xRatio < b.xRatio + b.widthRatio &&
  a.xRatio + a.widthRatio > b.xRatio &&
  a.yRatio < b.yRatio + b.heightRatio &&
  a.yRatio + a.heightRatio > b.yRatio;

/** Pick a predictable non-overlapping default slot for a new box. */
export const makeAvailableField = (
  page: number,
  existingOnPage: SignatureFieldProps[]
): SignatureFieldProps => {
  for (let index = 0; index < DEFAULT_SLOTS.length; index += 1) {
    const candidate = makeField(page, index);
    if (existingOnPage.every((field) => !overlaps(candidate, field))) return candidate;
  }
  return makeField(page, existingOnPage.length);
};

export { clamp };
