import { describe, expect, it } from 'vitest';
import { isTimeoutError, readBefore } from './fetchWithTimeout';

describe('readBefore', () => {
  it('gives up on a body that never arrives, and cancels the stream', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const error = await readBefore(stream.getReader(), Date.now() + 30).catch((e: unknown) => e);
    expect(isTimeoutError(error)).toBe(true);
    expect(cancelled).toBe(true);
  });

  it('passes chunks through while there is time', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const reader = stream.getReader();
    const first = await readBefore(reader, Date.now() + 1000);
    expect(first.value).toEqual(new Uint8Array([1, 2]));
    expect((await readBefore(reader, Date.now() + 1000)).done).toBe(true);
  });
});
