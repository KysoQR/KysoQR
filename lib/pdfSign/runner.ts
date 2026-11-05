import path from 'node:path';
import type { Worker, WorkerOptions } from 'node:worker_threads';
import { PdfSignError, type PdfSignErrorCode } from './errors.ts';
import type { PrepareJobInput, FinalizeJobInput, PdfJobName, PdfJobs } from './jobs.ts';
import { JOB_MAX_CONCURRENT, JOB_MAX_OLD_GENERATION_MB, JOB_TIMEOUT_MS } from './limits.ts';

/**
 * Runs a PDF job in a throwaway worker thread so that a hostile or merely
 * pathological PDF can only ever cost one worker:
 *   - a hard time limit (the worker is terminated, however it is spinning);
 *   - a heap cap for the JS objects pdf-lib builds;
 *   - a watchdog on the process's resident memory, because decompression
 *     buffers are off-heap and the heap cap does not see them;
 *   - at most JOB_MAX_CONCURRENT jobs at once (JOB_BUSY beyond that).
 *
 * This module is the only part of lib/pdfSign the Next.js server bundle
 * imports, and it must stay free of pdf-lib: the worker loads the PDF code
 * straight from the source files through Node's own TypeScript support, so
 * none of it goes through the bundler.
 */

export interface RunOptions {
  timeoutMs?: number;
  maxOldGenerationMb?: number;
  /** The process may not grow by more than this while the job runs. */
  maxRssGrowthBytes?: number;
  /** Worker entry file; tests point this at fixtures. */
  entry?: string;
}

const DEFAULT_MAX_RSS_GROWTH_BYTES = 768 * 1024 * 1024;
const WATCHDOG_INTERVAL_MS = 50;

let running = 0;

/** Built from the working directory, not import.meta.url: the bundler rewrites
 * the latter, and `next start` (VPS) runs from the project root. */
function defaultEntry(): string {
  return path.join(
    /* turbopackIgnore: true */ process.cwd(),
    'lib',
    'pdfSign',
    'worker',
    'pdfWorker.entry.mjs'
  );
}

/**
 * `new Worker(<file>)` is built through process.getBuiltinModule on purpose.
 * Turbopack recognizes the Worker constructor and, when the file name is not a
 * literal, treats it as "any file under the project": the build then tries to
 * bundle README.md, the fonts, vite and the rest of the tree as modules and
 * fails. A runtime lookup is invisible to the bundler, which is what we want:
 * the worker entry is plain files read by Node itself, never bundled.
 */
function startWorker(file: string, options: WorkerOptions): Worker {
  const { Worker: WorkerClass } = process.getBuiltinModule('node:worker_threads');
  return new WorkerClass(file, options);
}

interface WorkerReply {
  ok: boolean;
  result?: unknown;
  code?: PdfSignErrorCode;
  message?: string;
}

export function runPdfJob<N extends PdfJobName>(
  name: N,
  input: PdfJobs[N]['input'],
  options: RunOptions = {}
): Promise<PdfJobs[N]['output']> {
  if (running >= JOB_MAX_CONCURRENT) {
    return Promise.reject(new PdfSignError('JOB_BUSY', 'too many PDF jobs are running'));
  }
  running += 1;

  const timeoutMs = options.timeoutMs ?? JOB_TIMEOUT_MS;
  const rssLimit = options.maxRssGrowthBytes ?? DEFAULT_MAX_RSS_GROWTH_BYTES;
  const rssAtStart = process.memoryUsage.rss();

  return new Promise((resolve, reject) => {
    let settled = false;
    let worker: Worker | undefined;
    const timer = setTimeout(
      () => finish(new PdfSignError('JOB_TIMEOUT', `PDF job exceeded ${timeoutMs} ms`)),
      timeoutMs
    );
    const watchdog = setInterval(() => {
      if (process.memoryUsage.rss() - rssAtStart > rssLimit) {
        finish(new PdfSignError('PDF_UNSUPPORTED', 'PDF job used too much memory'));
      }
    }, WATCHDOG_INTERVAL_MS);

    function finish(outcome: PdfSignError | { result: unknown }) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watchdog);
      running -= 1;
      void worker?.terminate();
      if (outcome instanceof PdfSignError) reject(outcome);
      else resolve(outcome.result as PdfJobs[N]['output']);
    }

    try {
      worker = startWorker(options.entry ?? defaultEntry(), {
        workerData: { name, input },
        resourceLimits: {
          maxOldGenerationSizeMb: options.maxOldGenerationMb ?? JOB_MAX_OLD_GENERATION_MB,
          maxYoungGenerationSizeMb: 48,
          stackSizeMb: 4,
        },
      });
    } catch {
      finish(new PdfSignError('JOB_FAILED', 'could not start the PDF worker'));
      return;
    }
    worker.once('message', (reply: WorkerReply) => {
      if (reply.ok) finish({ result: reply.result });
      else finish(new PdfSignError(reply.code ?? 'JOB_FAILED', reply.message ?? 'PDF job failed'));
    });
    worker.once('error', (error: NodeJS.ErrnoException) => {
      // Out of heap: the PDF is too heavy for us, not a server fault.
      finish(
        error.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? new PdfSignError('PDF_UNSUPPORTED', 'PDF job ran out of memory')
          : new PdfSignError('JOB_FAILED', `PDF worker failed: ${error.name}`)
      );
    });
    worker.once('exit', (code) =>
      finish(new PdfSignError('JOB_FAILED', `PDF worker exited (${code}) without a result`))
    );
  });
}

// ---- typed helpers: Buffers in, Buffers out ----------------------------------------

const buf = (bytes: Uint8Array): Buffer =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function analyzeInWorker(pdf: Buffer, options?: RunOptions) {
  return runPdfJob('analyze', { pdf }, options);
}

export async function prepareInWorker(input: PrepareJobInput, options?: RunOptions) {
  const result = await runPdfJob('prepare', input, options);
  // A structured clone turns Buffers into plain Uint8Arrays.
  return {
    ...result,
    tail: buf(result.tail),
    contentDigest: buf(result.contentDigest),
    signedAttrsDer: buf(result.signedAttrsDer),
    digestToSign: buf(result.digestToSign),
  };
}

export async function finalizeInWorker(
  input: FinalizeJobInput,
  options?: RunOptions
): Promise<Buffer> {
  return buf(await runPdfJob('finalize', input, options));
}
