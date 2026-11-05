import { analyzePdf, type ExpectedAfter, type PdfAnalysis } from './analyze.ts';
import type { AppearanceContent } from './appearance.ts';
import { PdfSignError } from './errors.ts';
import { finalizePdf } from './finalize.ts';
import type { FieldPlacement } from './geometry.ts';
import { preparePdf, type PrepareResult } from './prepare.ts';

/**
 * The three things the app asks of the PDF code, as plain-data jobs: the
 * inputs and outputs only hold numbers, strings and byte arrays, so they cross
 * a worker-thread boundary with structured clone. runner.ts runs them in a
 * throwaway worker; tests call executePdfJob() directly.
 *
 * Byte arrays arrive as plain Uint8Array after a clone; every job turns them
 * back into Buffers before use.
 */

export type PdfJobName = 'analyze' | 'prepare' | 'finalize';

export interface AnalyzeJobInput {
  pdf: Uint8Array;
}

export interface PrepareJobInput {
  pdf: Uint8Array;
  fields: FieldPlacement[];
  appearance: AppearanceContent;
  signingTimeMs: number;
  certificateDer: Uint8Array;
  chainDer: Uint8Array[];
  timestampReserveBytes?: number | undefined;
}

export interface FinalizeJobInput {
  original: Uint8Array;
  tail: Uint8Array;
  byteRange: [number, number, number, number];
  contentsOffset: number;
  contentsLength: number;
  contentDigest: Uint8Array;
  signedAttrsDer: Uint8Array;
  certificateDer: Uint8Array;
  chainDer: Uint8Array[];
  signature: Uint8Array;
  timestampToken?: Uint8Array | undefined;
  analysis: PdfAnalysis;
  expected: ExpectedAfter;
}

export interface PdfJobs {
  analyze: { input: AnalyzeJobInput; output: PdfAnalysis };
  prepare: { input: PrepareJobInput; output: PrepareResult };
  finalize: { input: FinalizeJobInput; output: Buffer };
}

export const toBuffer = (bytes: Uint8Array): Buffer =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function bytes(value: unknown, label: string): Buffer {
  if (!(value instanceof Uint8Array))
    throw new PdfSignError('JOB_FAILED', `${label} must be bytes`);
  return toBuffer(value);
}

function byteList(value: unknown, label: string): Buffer[] {
  if (!Array.isArray(value))
    throw new PdfSignError('JOB_FAILED', `${label} must be a list of bytes`);
  return value.map((item, index) => bytes(item, `${label}[${index}]`));
}

export function executePdfJob<N extends PdfJobName>(
  name: N,
  input: PdfJobs[N]['input']
): Promise<PdfJobs[N]['output']>;
export async function executePdfJob(name: string, input: unknown): Promise<unknown> {
  switch (name) {
    case 'analyze':
      return analyzePdf(bytes((input as AnalyzeJobInput).pdf, 'pdf'));
    case 'prepare': {
      const job = input as PrepareJobInput;
      return preparePdf({
        pdf: bytes(job.pdf, 'pdf'),
        fields: job.fields,
        appearance: job.appearance,
        signingTime: new Date(job.signingTimeMs),
        certificateDer: bytes(job.certificateDer, 'certificateDer'),
        chainDer: byteList(job.chainDer, 'chainDer'),
        timestampReserveBytes: job.timestampReserveBytes,
      });
    }
    case 'finalize': {
      const job = input as FinalizeJobInput;
      return finalizePdf({
        original: bytes(job.original, 'original'),
        tail: bytes(job.tail, 'tail'),
        byteRange: job.byteRange,
        contentsOffset: job.contentsOffset,
        contentsLength: job.contentsLength,
        contentDigest: bytes(job.contentDigest, 'contentDigest'),
        signedAttrsDer: bytes(job.signedAttrsDer, 'signedAttrsDer'),
        certificateDer: bytes(job.certificateDer, 'certificateDer'),
        chainDer: byteList(job.chainDer, 'chainDer'),
        signature: bytes(job.signature, 'signature'),
        timestampToken: job.timestampToken
          ? bytes(job.timestampToken, 'timestampToken')
          : undefined,
        analysis: job.analysis,
        expected: job.expected,
      });
    }
    default:
      throw new PdfSignError('JOB_FAILED', 'unknown PDF job');
  }
}
