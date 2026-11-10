/**
 * Bounds a `fetch()` call with a hard timeout via `AbortController`, so one
 * slow/hung remote (a CA responder, CAS itself, ...) can't stall a request
 * indefinitely. Plain `AbortController`/`setTimeout` are standard Web
 * Platform APIs, not Node-specific -- this works identically whether the
 * route runs on the Ubuntu VPS (plain `next start`) or on Cloudflare Workers
 * (`@opennextjs/cloudflare`), unlike `node:http`'s custom `lookup` option
 * (see `lib/verification/aiaCertFetcher.ts`'s own doc comment for a case
 * that genuinely does need to branch by runtime -- this one doesn't).
 *
 * Extracted from `lib/verification/revocationChecker.ts`, which had its own
 * private copy of exactly this.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** `fetch()` rejects with this (via `AbortController.abort()` or the newer
 * `AbortSignal.timeout()`) when a request is aborted for taking too long --
 * lets callers give a specific "the remote didn't respond in time" message
 * instead of a generic failure. */
export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * `reader.read()` that gives up at `deadline` (ms since epoch). fetchWithTimeout
 * only covers the wait for the headers: a server that then sends its body a
 * byte at a time would hold the request forever. Rejects with a TimeoutError
 * (`isTimeoutError`) and cancels the stream.
 */
export async function readBefore<T>(
  reader: ReadableStreamDefaultReader<T>,
  deadline: number
): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        const error = new Error('body not received in time');
        error.name = 'TimeoutError';
        reject(error);
      },
      Math.max(0, deadline - Date.now())
    );
  });
  try {
    return await Promise.race([reader.read(), expired]);
  } catch (error) {
    if (isTimeoutError(error)) await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
