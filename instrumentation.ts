/**
 * Runs once when the Next.js server starts (`npm run dev`, `npm start`).
 *
 * When VNeID signing is configured (CMC_CA_HOST set), opens its SQLite
 * database right away -- creating the folder, the tables and the key file
 * (vneid.key) -- so a configuration problem shows in the
 * startup log instead of on the first signing request. Node runtime only;
 * skipped where VNeID is not configured (e.g. the Cloudflare Worker).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (!process.env.CMC_CA_HOST?.trim()) return;
  const { getVneidDeps } = await import('./lib/vneid/service');
  try {
    const deps = getVneidDeps();
    console.info('[vneid:startup] database ready', { path: deps.config.dbPath });
  } catch {
    // getVneidDeps has already logged why; the VNeID routes answer
    // VNEID_NOT_CONFIGURED and the rest of the app runs normally.
  }
}
