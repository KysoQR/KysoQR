// Test fixture: a worker that exhausts its JS heap.
const keep = [];
for (;;) keep.push(new Array(500_000).fill(1.5));
