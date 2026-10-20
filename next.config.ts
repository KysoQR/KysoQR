import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

const nextConfig: NextConfig = {
  // Kept intentionally minimal — no persistent-filesystem or Node-only config
  // baked in here, so the door to a future Cloud Worker/Edge target stays open.
  devIndicators: false,
  // Public pages canonicalize with a trailing slash (`/verify/`, `/opensource/`).
  // The automatic redirect is off so `/api/...` route handlers are not forced
  // onto a slash (that 308 turns a POST into a GET). `proxy.ts` adds the
  // slash for pages only.
  trailingSlash: true,
  skipTrailingSlashRedirect: true,
};

/**
 * Wires up Cloudflare bindings (ASSETS, the WORKER_SELF_REFERENCE service,
 * etc. -- see wrangler.jsonc) during plain `next dev`, so local dev behaves
 * the same way as the deployed Worker.
 *
 * Gated on Next's own `phase` argument (the only reliable dev-vs-production
 * signal) -- NOT on `@opennextjs/cloudflare`'s own internal dev-detection,
 * which turned out to also fire under `next start`. A real production VPS
 * deploy confirmed this the hard way: with `initOpenNextCloudflareForDev()`
 * called unconditionally at module scope (the previous version of this
 * file), `systemctl status` showed a stray `workerd` process running inside
 * the VPS's own systemd service, wasting memory/CPU for tooling that has no
 * business running outside local dev.
 */
export default function config(phase: string): NextConfig {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    initOpenNextCloudflareForDev();
  }
  return nextConfig;
}
