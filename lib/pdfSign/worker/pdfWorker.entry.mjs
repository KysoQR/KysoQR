// Entry point of the PDF worker thread (see ../runner.ts). Plain JavaScript on
// purpose: it is only glue, and the TypeScript it loads is read by Node's own
// type stripping, so this file works on every Node version we support whether
// or not `new Worker()` accepts a .ts path directly.
import { parentPort, workerData } from 'node:worker_threads';

const { name, input } = workerData;
try {
  const { executePdfJob } = await import('../jobs.ts');
  const result = await executePdfJob(name, input);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    code:
      typeof error?.code === 'string' && error.name === 'PdfSignError' ? error.code : 'JOB_FAILED',
    // Only the message of our own errors is meant to be read; anything else
    // (a pdf-lib exception, say) is reduced to its type.
    message:
      error?.name === 'PdfSignError'
        ? String(error.message)
        : `unexpected ${error?.name ?? 'error'}`,
  });
}
