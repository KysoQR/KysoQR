import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Be Vietnam Pro, the font the page already ships for the UI. Read from disk
 * (this code only ever runs under Node -- a worker thread on the VPS -- never
 * on the Cloudflare Worker, which has no filesystem).
 */
const FONT_DIR = new URL('../../public/fonts/Be_Vietnam_Pro/', import.meta.url);

export interface AppearanceFontBytes {
  regular: Buffer;
}

let cached: AppearanceFontBytes | undefined;

export function loadAppearanceFonts(): AppearanceFontBytes {
  cached ??= {
    regular: readFileSync(fileURLToPath(new URL('BeVietnamPro-Regular.ttf', FONT_DIR))),
  };
  return cached;
}
