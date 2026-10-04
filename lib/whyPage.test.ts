import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readWhyPage } from './whyPage';

describe('readWhyPage', () => {
  let dir: string;
  const makeDir = () => (dir = mkdtempSync(path.join(tmpdir(), 'why-page-')));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (root: string, html: string) => {
    const publicDir = path.join(root, 'public');
    mkdirSync(publicDir, { recursive: true });
    writeFileSync(path.join(publicDir, 'why.html'), html);
  };

  it('returns null when public/why.html does not exist', () => {
    expect(readWhyPage(makeDir())).toBeNull();
  });

  it('returns null when public/why.html is empty or whitespace only', () => {
    const root = makeDir();
    write(root, '  \n\n ');
    expect(readWhyPage(root)).toBeNull();
  });

  it('returns the html when public/why.html has content', () => {
    const root = makeDir();
    write(root, '<h1>Vì sao</h1>');
    expect(readWhyPage(root)).toContain('<h1>Vì sao</h1>');
  });
});
