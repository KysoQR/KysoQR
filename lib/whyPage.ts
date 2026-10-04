import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Optional static page at `public/why.html`, served by Next at `/why.html`.
 * Drop the file on the server (no rebuild) to show "Vì sao / Ký số QR". */
export const WHY_PAGE_PATH = '/why.html';
const WHY_PAGE_FILE = path.join('public', 'why.html');

/** Non-empty `public/why.html` under `rootDir`, or null when missing/blank. */
export function readWhyPage(rootDir = process.cwd()): string | null {
  const filePath = path.join(rootDir, WHY_PAGE_FILE);
  if (!existsSync(filePath)) return null;
  try {
    const html = readFileSync(filePath, 'utf8');
    return html.trim() ? html : null;
  } catch {
    return null;
  }
}
