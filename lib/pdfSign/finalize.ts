import { createHash } from 'node:crypto';
import { type ExpectedAfter, loadPdfForSigning, type PdfAnalysis } from './analyze.ts';
import { assembleCms, buildSignedAttributes } from './cms.ts';
import { PdfSignError } from './errors.ts';
import { assertAppendedUpdateIsExact } from './incremental.ts';
import { MAX_PDF_BYTES } from './limits.ts';
import { widgetProblem, widgetSnapshot } from './widgets.ts';

/**
 * Phase 2 of a signature: puts the CMS built around CSign's signature into the
 * placeholder preparePdf() left, and checks the result before returning it.
 *
 * Fail closed: any mismatch between what was prepared and what is being
 * finalized, a signature that does not verify, a placeholder that is not
 * untouched, an xref section that is not exact, or a result that does not look
 * like "the original plus exactly one more signature" throws instead of
 * returning a file.
 */

export interface FinalizeInput {
  /** The file the update was prepared for. */
  original: Buffer;
  /** `tail` as preparePdf() returned it (/ByteRange filled, /Contents zeros). */
  tail: Buffer;
  byteRange: [number, number, number, number];
  contentsOffset: number;
  contentsLength: number;
  contentDigest: Buffer;
  signedAttrsDer: Buffer;
  certificateDer: Buffer;
  chainDer: Buffer[];
  /** Raw RSA signature from CSign. */
  signature: Buffer;
  /** RFC 3161 token over `signature`, embedded as an unsigned attribute. */
  timestampToken?: Buffer | undefined;
  analysis: PdfAnalysis;
  expected: ExpectedAfter;
}

/** The update adds a few hundred KB at most (fonts, appearance, placeholder). */
const MAX_UPDATE_BYTES = 2 * 1024 * 1024;

const mismatch = (what: string) => new PdfSignError('FINALIZE_MISMATCH', what);

export async function finalizePdf(input: FinalizeInput): Promise<Buffer> {
  const { original, tail } = input;
  const [start, contentsStart, contentsEnd, rest] = input.byteRange;
  const total = original.length + tail.length;

  if (original.length !== input.analysis.byteLength)
    throw mismatch('original has a different length');
  if (tail.length > MAX_UPDATE_BYTES) throw mismatch('update is implausibly large');
  if (
    start !== 0 ||
    contentsStart !== input.contentsOffset ||
    contentsEnd !== input.contentsOffset + input.contentsLength ||
    rest !== total - contentsEnd ||
    input.contentsLength < 4 ||
    input.contentsLength % 2 !== 0 ||
    contentsStart < original.length
  ) {
    throw mismatch('byte range is not consistent with the prepared update');
  }

  const pdf = Buffer.concat([original, tail], total);

  // The placeholder must be exactly "<" + zeros + ">": nothing else may have
  // been written into the signature value since it was prepared.
  if (pdf[input.contentsOffset] !== 0x3c || pdf[contentsEnd - 1] !== 0x3e) {
    throw mismatch('/Contents is not delimited by < and >');
  }
  for (let i = input.contentsOffset + 1; i < contentsEnd - 1; i += 1) {
    if (pdf[i] !== 0x30) throw mismatch('/Contents placeholder is not empty');
  }

  // Same bytes as were hashed when the update was prepared.
  const digest = createHash('sha256')
    .update(pdf.subarray(0, contentsStart))
    .update(pdf.subarray(contentsEnd))
    .digest();
  if (!digest.equals(input.contentDigest))
    throw mismatch('file differs from the one that was prepared');
  if (
    !buildSignedAttributes(input.contentDigest, input.certificateDer).der.equals(
      input.signedAttrsDer
    )
  ) {
    throw mismatch('signed attributes differ from the ones that were sent for signing');
  }

  // Verifies the RSA signature, then builds the CMS around it.
  const cms = assembleCms({
    signedAttrsDer: input.signedAttrsDer,
    certificateDer: input.certificateDer,
    chainDer: input.chainDer,
    signature: input.signature,
    timestampToken: input.timestampToken,
  });
  const hex = cms.toString('hex').toUpperCase();
  if (hex.length > input.contentsLength - 2) {
    throw new PdfSignError('SIGNATURE_TOO_LARGE', 'the CMS does not fit the reserved /Contents');
  }
  pdf.write(hex, input.contentsOffset + 1, 'latin1');

  // --- self-check of the finished file ---------------------------------------------
  assertAppendedUpdateIsExact(
    pdf.subarray(original.length),
    original.length,
    input.analysis.xrefKind,
    input.analysis.prevStartXref
  );
  if (!pdf.subarray(0, original.length).equals(original))
    throw mismatch('the original bytes changed');

  let loaded;
  try {
    loaded = await loadPdfForSigning(pdf, MAX_PDF_BYTES + MAX_UPDATE_BYTES);
  } catch (error) {
    if (error instanceof PdfSignError) {
      throw new PdfSignError('SELF_CHECK_FAILED', `the signed file does not load: ${error.code}`);
    }
    throw error;
  }
  const after = loaded.analysis;
  const expected = input.expected;
  const same =
    after.pageCount === expected.pageCount &&
    after.signatureCount === expected.signatureCount &&
    after.acroFormFieldCount === expected.acroFormFieldCount &&
    after.xrefKind === input.analysis.xrefKind &&
    after.docMdpPermission === input.analysis.docMdpPermission &&
    after.pageAnnotCounts.length === expected.pageAnnotCounts.length &&
    after.pageAnnotCounts.every((count, i) => count === expected.pageAnnotCounts[i]);
  if (!same) {
    throw new PdfSignError(
      'SELF_CHECK_FAILED',
      'the signed file does not have the expected pages, fields, annotations and signatures'
    );
  }
  // And as a viewer reads it: every earlier widget still shows, the new one too.
  if (expected.widgets) {
    let problem: string | undefined;
    try {
      problem = widgetProblem(expected.widgets.before, await widgetSnapshot(pdf), expected.widgets);
    } catch (error) {
      if (!(error instanceof PdfSignError)) throw error;
      problem = `it cannot be read as a viewer reads it (${error.code})`;
    }
    if (problem) {
      throw new PdfSignError(
        'SELF_CHECK_FAILED',
        `the signed file would not show right: ${problem}`
      );
    }
  }
  return pdf;
}
