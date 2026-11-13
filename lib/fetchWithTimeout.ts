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
