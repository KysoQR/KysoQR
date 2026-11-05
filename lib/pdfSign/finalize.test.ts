import { beforeAll, describe, expect, it } from 'vitest';
import { finalizePdf, type FinalizeInput } from './finalize.ts';
import { preparePdf } from './prepare.ts';
import {
  APPEARANCE,
  BOX,
  createSamplePdf,
  createSoftIdentity,
  type SoftIdentity,
} from './testHelpers.ts';

/**
 * finalize fails closed: whatever was prepared must be exactly what is being
 * finalized, the signature must verify, and the result must look like the
 * original plus one signature.
 */

describe('finalizePdf', () => {
  let identity: SoftIdentity;
  let original: Buffer;
  let input: FinalizeInput;
  let digestToSign: Buffer;
  const flip = (buffer: Buffer, index: number) => {
    buffer[index] = buffer[index]! ^ 0x01;
  };

  beforeAll(async () => {
    identity = createSoftIdentity({ levels: 2 });
  });

  const fresh = async (objectStreams = false) => {
    original = await createSamplePdf({ objectStreams });
    const prepared = await preparePdf({
      pdf: original,
      fields: [BOX],
      appearance: APPEARANCE,
      signingTime: new Date(),
      certificateDer: identity.certificateDer,
      chainDer: identity.chainDer,
    });
    digestToSign = prepared.digestToSign;
    input = {
      original,
      ...prepared,
      certificateDer: identity.certificateDer,
      chainDer: identity.chainDer,
      signature: identity.remoteSign(prepared.digestToSign),
    };
  };

  const code = (error: unknown) => (error as { code?: string }).code;
  const failsWith = async (expected: string, change: (copy: FinalizeInput) => void) => {
    const copy: FinalizeInput = {
      ...input,
      tail: Buffer.from(input.tail),
      original: Buffer.from(input.original),
    };
    change(copy);
    await expect(finalizePdf(copy)).rejects.toSatisfy((error: unknown) => code(error) === expected);
  };

  for (const objectStreams of [false, true]) {
    it(`finalizing the same prepared update twice gives the same bytes (objectStreams=${objectStreams})`, async () => {
      await fresh(objectStreams);
      const a = await finalizePdf({ ...input });
      const b = await finalizePdf({ ...input });
      expect(a.equals(b)).toBe(true);
    });
  }

  it('refuses a different original: another byte, another length', async () => {
    await fresh();
    await failsWith('FINALIZE_MISMATCH', (copy) => {
      flip(copy.original, Math.floor(copy.original.length / 2));
    });
    await failsWith('FINALIZE_MISMATCH', (copy) => {
      copy.original = Buffer.concat([copy.original, Buffer.from('\n')]);
    });
  });

  it('refuses an update whose bytes changed since it was prepared', async () => {
    await fresh();
    // Somewhere inside an appended object (not the placeholder).
    await failsWith('FINALIZE_MISMATCH', (copy) => {
      flip(copy.tail, 40);
    });
  });

  it('refuses a /Contents placeholder that is no longer empty', async () => {
    await fresh();
    await failsWith('FINALIZE_MISMATCH', (copy) => {
      copy.tail[copy.contentsOffset - copy.original.length + 5] = 0x41;
    });
    await failsWith('FINALIZE_MISMATCH', (copy) => {
      copy.tail[copy.contentsOffset - copy.original.length] = 0x28; // "(" instead of "<"
    });
  });

  it('refuses a byte range that does not match the prepared update', async () => {
    await fresh();
    await failsWith('FINALIZE_MISMATCH', (copy) => {
      copy.byteRange = [0, copy.byteRange[1] + 2, copy.byteRange[2], copy.byteRange[3]];
    });
    await failsWith('FINALIZE_MISMATCH', (copy) => {
      copy.byteRange = [0, copy.byteRange[1], copy.byteRange[2], copy.byteRange[3] - 1];
    });
    await failsWith('FINALIZE_MISMATCH', (copy) => {
      copy.contentsOffset = copy.contentsOffset - 1;
    });
  });

  it('refuses a signature from another key, or signed attributes that are not the ones sent', async () => {
    await fresh();
    const stranger = createSoftIdentity();
    await failsWith('SIGNATURE_INVALID', (copy) => {
      copy.signature = stranger.remoteSign(digestToSign);
    });
    await failsWith('FINALIZE_MISMATCH', (copy) => {
      copy.signedAttrsDer = Buffer.from(copy.signedAttrsDer);
      flip(copy.signedAttrsDer, copy.signedAttrsDer.length - 1);
    });
  });

  it('refuses a result that does not look like the original plus one signature', async () => {
    await fresh();
    await failsWith('SELF_CHECK_FAILED', (copy) => {
      copy.expected = { ...copy.expected, signatureCount: copy.expected.signatureCount + 1 };
    });
    await failsWith('SELF_CHECK_FAILED', (copy) => {
      copy.expected = { ...copy.expected, pageAnnotCounts: [...copy.expected.pageAnnotCounts, 9] };
    });
    await failsWith('SELF_CHECK_FAILED', (copy) => {
      copy.expected = { ...copy.expected, acroFormFieldCount: 7 };
    });
  });

  it('refuses an xref section that does not match its objects', async () => {
    await fresh();
    await failsWith('SELF_CHECK_FAILED', (copy) => {
      // Point /Prev somewhere else: the trailer no longer chains to the original.
      copy.analysis = { ...copy.analysis, prevStartXref: copy.analysis.prevStartXref + 1 };
    });
  });
});
