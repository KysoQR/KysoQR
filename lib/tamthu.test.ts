import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTamThuHtml } from './tamthu';

describe('readTamThuHtml', () => {
  let dir: string | undefined;
  const makeDir = () => (dir = mkdtempSync(path.join(tmpdir(), 'tamthu-')));

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('returns null when tamthu.md does not exist', () => {
    expect(readTamThuHtml(makeDir())).toBeNull();
  });

  it('returns null when tamthu.md is empty or whitespace only', () => {
    const root = makeDir();
    writeFileSync(path.join(root, 'tamthu.md'), '  \n\n ');
    expect(readTamThuHtml(root)).toBeNull();
  });

  it('renders the markdown to HTML when the file has content', () => {
    const root = makeDir();
    writeFileSync(path.join(root, 'tamthu.md'), '# Tâm thư\n\nXin chào **bạn**.');
    const html = readTamThuHtml(root);
    expect(html).toContain('<h1>Tâm thư</h1>');
    expect(html).toContain('<strong>bạn</strong>');
  });
});
