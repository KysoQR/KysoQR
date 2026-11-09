import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Be Vietnam Pro, the font the page already ships for the UI. Read from disk
 * (this code only ever runs under Node -- a worker thread on the VPS -- never
 * on the Cloudflare Worker, which has no filesystem).
 */
const FONT_DIR = new URL('../../public/fonts/Be_Vietnam_Pro/', import.meta.url);
const BRAND_DIR = new URL('../../public/brand/', import.meta.url);

export interface AppearanceFontBytes {
  regular: Buffer;
  /** The signer's name in VNeID's look. */
  semibold: Buffer;
}

export interface AppearanceImageBytes {
  /** VNeID's logo, 256 x 256 PNG rendered from public/brand/vneid.svg. */
  vneidLogo: Buffer;
}

let cached: AppearanceFontBytes | undefined;
let cachedImages: AppearanceImageBytes | undefined;

export function loadAppearanceFonts(): AppearanceFontBytes {
  cached ??= {
    regular: readFileSync(fileURLToPath(new URL('BeVietnamPro-Regular.ttf', FONT_DIR))),
    semibold: readFileSync(fileURLToPath(new URL('BeVietnamPro-SemiBold.ttf', FONT_DIR))),
  };
  return cached;
}

export function loadAppearanceImages(): AppearanceImageBytes {
  cachedImages ??= {
    vneidLogo: readFileSync(fileURLToPath(new URL('vneid-signature.png', BRAND_DIR))),
  };
  return cachedImages;
}
