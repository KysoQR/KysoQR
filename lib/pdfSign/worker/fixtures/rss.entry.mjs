// Test fixture: a worker that grows OFF-heap memory (decompression buffers), which the heap cap cannot see.
const keep = [];
for (;;) {
  const chunk = Buffer.alloc(8 * 1024 * 1024);
  chunk.fill(7);
  keep.push(chunk);
}
