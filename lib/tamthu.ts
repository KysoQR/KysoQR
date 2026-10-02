import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';

/** Optional `tamthu.md` at the project root (next to package.json). */
const TAMTHU_FILE = 'tamthu.md';

/**
 * Server-only. Returns the letter rendered to HTML, or `null` when the file
 * does not exist, is empty, or cannot be read -- in which case the feature
 * simply does not exist: no button, no request, no error, no log.
 */
export function readTamThuHtml(rootDir: string = process.cwd()): string | null {
  const filePath = path.join(rootDir, TAMTHU_FILE);
  if (!existsSync(filePath)) return null;
  try {
    const markdown = readFileSync(filePath, 'utf8').trim();
    if (!markdown) return null;
    return marked.parse(markdown, { async: false });
  } catch {
    return null;
  }
}
