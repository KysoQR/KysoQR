/** Hard limits applied before and while a PDF is processed. */

/** Same ceiling as the CAS flow (lib/documentName.ts CAS_MAX_FILE_BYTES). */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_PAGES = 1000;
/** Signature boxes on one signature (the UI draws a handful at most). */
export const MAX_FIELDS = 10;

/** PDF user-space limits for a page box (ISO 32000-1 Annex C: 14400 pt max). */
export const MIN_PAGE_SIDE_PT = 72;
export const MAX_PAGE_SIDE_PT = 14_400;

/** Largest inflated size accepted for a single object stream. pdf-lib inflates
 * every /ObjStm while loading, with no cap of its own. */
export const MAX_OBJSTM_INFLATED_BYTES = 32 * 1024 * 1024;

/** `/ByteRange` occurrences accepted in a file to sign (real files: a few). */
export const MAX_BYTE_RANGES = 100;

/** Bytes reserved for the CMS inside /Contents (hex doubles it in the file). */
export const DEFAULT_CONTENTS_BYTES = 16 * 1024;
export const MAX_CONTENTS_BYTES = 64 * 1024;
/** CMS = signer certificate + chain; more than this is not a real chain. */
export const MAX_CHAIN_CERTS = 4;

/** Text drawn inside the visible signature box. */
export const MAX_NAME_CHARS = 100;
export const MAX_DETAIL_LINES = 8;
export const MAX_DETAIL_CHARS = 160;

/** The worker is killed past this. */
export const JOB_TIMEOUT_MS = 10_000;
/** Heap cap per worker (pdf-lib builds a JS object per PDF object). */
export const JOB_MAX_OLD_GENERATION_MB = 384;
export const JOB_MAX_CONCURRENT = 2;
