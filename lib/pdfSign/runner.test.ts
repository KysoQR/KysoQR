import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyPdfSignatures } from '../verification/verifyPdfSignatures';
import { MAX_OBJSTM_INFLATED_BYTES } from './limits.ts';
import { analyzeInWorker, finalizeInWorker, prepareInWorker, runPdfJob } from './runner.ts';
import {
  APPEARANCE,
  BOX,
  createSamplePdf,
  createSoftIdentity,
  minimalDocument,
  type SoftIdentity,
} from './testHelpers.ts';

const fixture = (name: string) =>
  path.join(process.cwd(), 'lib', 'pdfSign', 'worker', 'fixtures', name);
const FAST = { timeoutMs: 400 };

describe('the real worker', () => {
  let identity: SoftIdentity;
  beforeAll(() => {
    identity = createSoftIdentity({ levels: 2 });
  });

  it('analyze, prepare and finalize give a signature KysoQR verifies', async () => {
    for (const objectStreams of [false, true]) {
      const original = await createSamplePdf({ objectStreams });
      const analysis = await analyzeInWorker(original);
      expect(analysis).toMatchObject({
        pageCount: 2,
        xrefKind: objectStreams ? 'stream' : 'table',
      });

      const prepared = await prepareInWorker({
        pdf: original,
        fields: [BOX],
        appearance: APPEARANCE,
        signingTimeMs: Date.now(),
        certificateDer: identity.certificateDer,
        chainDer: identity.chainDer,
      });
      // Byte arrays come back as Buffers, not plain Uint8Arrays.
      expect(Buffer.isBuffer(prepared.tail)).toBe(true);
      expect(prepared.digestToSign).toHaveLength(32);

      const signed = await finalizeInWorker({
        original,
        ...prepared,
        certificateDer: identity.certificateDer,
        chainDer: identity.chainDer,
        signature: identity.remoteSign(prepared.digestToSign),
      });
      expect(Buffer.isBuffer(signed)).toBe(true);
      const results = await verifyPdfSignatures(signed, identity.trustStore);
      expect(results.map((r) => r.status)).toEqual(['SIGNED_VALID']);
    }
  }, 30_000);

  it('hands our own error codes back across the thread boundary', async () => {
    await expect(
      analyzeInWorker(Buffer.from('this is not a pdf at all, nothing to see'))
    ).rejects.toMatchObject({ code: 'PDF_INVALID' });

    const encrypted = minimalDocument({
      trailer: '/Encrypt 9 0 R',
      objects: [{ number: 9, body: '<< /Filter /Standard /V 1 /R 2 /O (0000) /U (0000) /P -4 >>' }],
    });
    await expect(analyzeInWorker(encrypted)).rejects.toMatchObject({ code: 'PDF_ENCRYPTED' });

    const bomb = deflateSync(Buffer.alloc(MAX_OBJSTM_INFLATED_BYTES + 1024 * 1024));
    const hostile = minimalDocument({
      objects: [
        {
          number: 9,
          body: `<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${bomb.length} >>\nstream\n${bomb.toString('latin1')}\nendstream`,
        },
      ],
    });
    await expect(analyzeInWorker(hostile)).rejects.toMatchObject({ code: 'PDF_UNSUPPORTED' });
  }, 30_000);

  it('does not leak what an unexpected exception said', async () => {
    // A job with bad input: fails inside the worker with a non-PdfSignError.
    await expect(
      runPdfJob('analyze', { pdf: 'not bytes' as unknown as Uint8Array })
    ).rejects.toMatchObject({ code: 'JOB_FAILED' });
  });
});

describe('a worker that misbehaves costs only itself', () => {
  const normalJob = async () =>
    expect(await analyzeInWorker(await createSamplePdf())).toMatchObject({ pageCount: 2 });

  it('is killed at the time limit while the server keeps running', async () => {
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 20);
    const started = performance.now();
    await expect(
      runPdfJob('analyze', { pdf: Buffer.alloc(0) }, { ...FAST, entry: fixture('hang.entry.mjs') })
    ).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
    const elapsed = performance.now() - started;
    clearInterval(timer);
    expect(elapsed).toBeLessThan(2500);
    // The event loop kept turning for the whole time the worker was spinning.
    expect(ticks).toBeGreaterThan(8);
    await normalJob();
  }, 20_000);

  it('is stopped when it runs out of heap, reported as an unsupported PDF', async () => {
    await expect(
      runPdfJob(
        'analyze',
        { pdf: Buffer.alloc(0) },
        { timeoutMs: 15_000, maxOldGenerationMb: 24, entry: fixture('oom.entry.mjs') }
      )
    ).rejects.toMatchObject({
      code: 'PDF_UNSUPPORTED',
      message: expect.stringContaining('memory'),
    });
    await normalJob();
  }, 30_000);

  it('is stopped when it grows memory the heap cap cannot see (decompression buffers)', async () => {
    const started = performance.now();
    await expect(
      runPdfJob(
        'analyze',
        { pdf: Buffer.alloc(0) },
        { timeoutMs: 15_000, maxRssGrowthBytes: 150 * 1024 * 1024, entry: fixture('rss.entry.mjs') }
      )
    ).rejects.toMatchObject({
      code: 'PDF_UNSUPPORTED',
      message: expect.stringContaining('memory'),
    });
    expect(performance.now() - started).toBeLessThan(10_000);
    await normalJob();
  }, 30_000);

  it('reports a worker that throws or exits without answering', async () => {
    await expect(
      runPdfJob('analyze', { pdf: Buffer.alloc(0) }, { entry: fixture('crash.entry.mjs') })
    ).rejects.toMatchObject({ code: 'JOB_FAILED' });
    await expect(
      runPdfJob('analyze', { pdf: Buffer.alloc(0) }, { entry: fixture('exit.entry.mjs') })
    ).rejects.toMatchObject({ code: 'JOB_FAILED' });
    await normalJob();
  });

  it('never runs more than the allowed number of jobs at once', async () => {
    const hang = () =>
      runPdfJob(
        'analyze',
        { pdf: Buffer.alloc(0) },
        { timeoutMs: 700, entry: fixture('hang.entry.mjs') }
      );
    const first = hang();
    const second = hang();
    // A third arrives while two are running: refused at once, not queued.
    await expect(analyzeInWorker(await createSamplePdf())).rejects.toMatchObject({
      code: 'JOB_BUSY',
    });
    await expect(first).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
    await expect(second).rejects.toMatchObject({ code: 'JOB_TIMEOUT' });
    // The slots are free again.
    await normalJob();
  }, 20_000);
});
